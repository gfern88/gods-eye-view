/**
 * Deepgram Voice Agent <-> OpenAI Realtime event translation.
 *
 * The voice turn machinery (realtimeTurns.js) speaks the OpenAI Realtime
 * event protocol. This translator lets a Deepgram agent socket stand in for
 * the WebRTC data channel: Deepgram server messages become the OpenAI events
 * the turns owner expects, and the client events it sends become Deepgram
 * messages (or local playback actions). Pure apart from the injected hooks.
 *
 * Invariants the turns owner relies on:
 * - one explicit response is open or closed; every `response.*` event is
 *   emitted only while one is open, and `response.done` only closes an open one;
 * - a tool call ends its response (OpenAI semantics); the agent's spoken reply
 *   to the tool result is a new response;
 * - tool results are held until the matching `response.create`, so Deepgram
 *   cannot reply before the turn owner asks, and the follow-up instructions
 *   travel with the result instead of being lost;
 * - `response.create` never leaves `responseCreatePending` stranded: a reply
 *   that never comes is closed by a watchdog.
 */

export const REPLY_WATCHDOG_MS = 10_000;
export const UNREQUESTED_OUTPUT_FLUSH_MS = 1_500;

export class DeepgramTranslator {
  /**
   * @param {{
   *   emit: (event: object) => void,
   *   send: (message: object) => void,
   *   stopPlayback: () => void,
   *   log?: (name: string, detail?: object) => void,
   *   timers?: {setTimeout: Function, clearTimeout: Function},
   * }} hooks
   */
  constructor({
    emit,
    send,
    stopPlayback,
    log = () => {},
    timers = globalThis,
  }) {
    Object.assign(this, { emit, send, stopPlayback, log, timers });
    this.sequence = 0;
    this.open = null; // { id }
    this.lastCancelledId = null;
    this.dropAgent = false;
    this.playbackActive = false;
    this.serverAudioDone = false;
    this.callNames = new Map();
    this.cancelledCalls = new Set();
    this.pendingRequest = null; // { ids: Set, answered: Map }
    this.createRequested = null; // { instructions }
    this.replyExpected = false;
    this.heldUserText = null;
    this.watchdog = null;
    this.flushTimer = null;
  }

  nextId(prefix) {
    return `dg_${prefix}_${++this.sequence}`;
  }

  // ---- response bookkeeping ----------------------------------------------

  ensureOpen() {
    if (this.open) return this.open.id;
    this.open = { id: this.nextId('resp') };
    this.serverAudioDone = false;
    this.replyExpected = false;
    this.clearWatchdog();
    this.emit({ type: 'response.created', response: { id: this.open.id } });
    return this.open.id;
  }

  closeResponse(status) {
    if (!this.open) return;
    const { id } = this.open;
    this.open = null;
    this.emit({ type: 'response.done', response: { id, status } });
    this.maybeSendHeldText();
  }

  /** A typed command held during a reply goes out once the agent is idle. */
  maybeSendHeldText() {
    if (!this.heldUserText || this.open || this.playbackActive) return;
    if (this.pendingRequest) return;
    const text = this.heldUserText;
    this.heldUserText = null;
    this.sendUserText(text);
    this.armWatchdog();
  }

  /** A response.create the agent will not answer: open and close at once. */
  emptyResponse() {
    this.ensureOpen();
    this.closeResponse('completed');
  }

  armWatchdog() {
    this.clearWatchdog();
    this.replyExpected = true;
    this.watchdog = this.timers.setTimeout(() => {
      this.watchdog = null;
      if (!this.replyExpected || this.open) return;
      this.replyExpected = false;
      this.log('deepgram.reply.watchdog');
      this.emptyResponse();
    }, REPLY_WATCHDOG_MS);
  }

  clearWatchdog() {
    if (this.watchdog) this.timers.clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /** Local interruption: stop audio, end the response, ignore its remainder. */
  interrupt() {
    this.stopPlayback();
    this.playbackStopped('output_audio_buffer.cleared');
    if (this.open) {
      this.lastCancelledId = this.open.id;
      this.dropAgent = true;
      this.closeResponse('cancelled');
    }
  }

  // ---- playback (called by the connection) ---------------------------------

  /**
   * An agent audio frame arrived. Returns false when it must not be played.
   * @returns {boolean}
   */
  acceptAudio() {
    if (this.dropAgent) return false;
    const responseId = this.ensureOpen();
    if (!this.playbackActive) {
      this.playbackActive = true;
      this.emit({
        type: 'output_audio_buffer.started',
        response_id: responseId,
      });
    }
    return true;
  }

  /** Every scheduled frame has finished playing. */
  playbackDrained() {
    this.playbackStopped('output_audio_buffer.stopped');
    if (this.serverAudioDone) this.closeResponse('completed');
  }

  playbackStopped(type) {
    if (!this.playbackActive) return;
    this.playbackActive = false;
    this.emit({ type, ...(this.open ? { response_id: this.open.id } : {}) });
    this.maybeSendHeldText();
  }

  // ---- Deepgram -> OpenAI ---------------------------------------------------

  handleServerMessage(message) {
    switch (message?.type) {
      case 'UserStartedSpeaking':
        // speech_started first so userTurnPending blocks queued follow-ups
        // before the interrupted response's done arrives.
        this.emit({ type: 'input_audio_buffer.speech_started' });
        this.replyExpected = false;
        this.heldUserText = null;
        this.clearWatchdog();
        this.interrupt();
        this.dropAgent = false;
        return;
      case 'ConversationText':
        if (message.role === 'user') {
          const itemId = this.nextId('item');
          this.emit({
            type: 'input_audio_buffer.speech_stopped',
            item_id: itemId,
          });
          this.emit({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: itemId,
            transcript: String(message.content || ''),
          });
          return;
        }
        if (message.role === 'assistant' && !this.dropAgent) {
          const responseId = this.ensureOpen();
          const itemId = this.nextId('item');
          const text = String(message.content || '');
          this.emit({
            type: 'response.output_audio_transcript.delta',
            response_id: responseId,
            item_id: itemId,
            delta: text,
          });
          this.emit({
            type: 'response.output_audio_transcript.done',
            response_id: responseId,
            item_id: itemId,
            transcript: text,
          });
        }
        return;
      case 'AgentThinking':
      case 'AgentStartedSpeaking':
        if (!this.dropAgent) this.ensureOpen();
        return;
      case 'FunctionCallRequest':
        this.handleFunctionCallRequest(message);
        return;
      case 'FunctionCallCancelled':
        for (const fn of message.functions || []) {
          this.cancelledCalls.add(fn.id);
          this.pendingRequest?.ids.delete(fn.id);
        }
        this.maybeFlush();
        return;
      case 'AgentAudioDone':
        this.serverAudioDone = true;
        if (!this.playbackActive) this.closeResponse('completed');
        return;
      case 'InjectionRefused':
        if (this.replyExpected && !this.open) {
          this.replyExpected = false;
          this.clearWatchdog();
          this.emptyResponse();
        }
        this.log('deepgram.injection_refused', { message: message.message });
        return;
      // Error messages are owned by the connection (it ends the session).
      default:
        this.log('deepgram.server_message', { type: message?.type || null });
    }
  }

  handleFunctionCallRequest(message) {
    const calls = (message.functions || []).filter(
      (fn) => fn && fn.client_side !== false,
    );
    if (!calls.length) return;
    this.pendingRequest ||= { ids: new Set(), answered: new Map() };
    for (const fn of calls) {
      this.callNames.set(fn.id, fn.name);
      this.pendingRequest.ids.add(fn.id);
    }
    // Calls from an interrupted reply belong to the cancelled response, which
    // the turns owner refuses as superseded (it still answers each one).
    const responseId = this.dropAgent
      ? this.lastCancelledId
      : this.ensureOpen();
    for (const fn of calls) {
      this.emit({
        type: 'response.output_item.done',
        response_id: responseId,
        item: {
          type: 'function_call',
          id: this.nextId('item'),
          call_id: fn.id,
          name: fn.name,
          arguments:
            typeof fn.arguments === 'string'
              ? fn.arguments
              : JSON.stringify(fn.arguments ?? {}),
        },
      });
    }
    if (!this.dropAgent) this.closeResponse('completed');
  }

  // ---- OpenAI -> Deepgram ---------------------------------------------------

  /**
   * Translate one client event. Returns false when it cannot be delivered,
   * which callers already treat as a failed best-effort send.
   * @param {object} event
   * @returns {boolean}
   */
  handleClientEvent(event) {
    switch (event?.type) {
      case 'conversation.item.create':
        return this.handleItemCreate(event.item || {});
      case 'response.create': {
        const response = event.response || {};
        // Out-of-band progress narration has no Deepgram equivalent.
        if (response.conversation === 'none') return false;
        if (this.pendingRequest) {
          this.createRequested = { instructions: response.instructions || '' };
          this.maybeFlush();
          return true;
        }
        this.maybeSendHeldText();
        if (this.replyExpected || this.heldUserText) {
          this.armWatchdog();
          return true;
        }
        // A reply already under way answers this request itself.
        if (this.open) return true;
        this.emptyResponse();
        return true;
      }
      case 'response.cancel':
      case 'output_audio_buffer.clear':
        // A barge-in is the user taking the floor: a held typed command is stale.
        this.heldUserText = null;
        this.interrupt();
        return true;
      case 'conversation.item.delete':
        return true;
      default:
        return false;
    }
  }

  handleItemCreate(item) {
    if (item.type === 'function_call_output') {
      const id = item.call_id;
      if (!id || this.cancelledCalls.has(id)) return true;
      const content = String(item.output ?? '');
      if (this.pendingRequest?.ids.has(id)) {
        this.pendingRequest.answered.set(id, content);
        this.maybeFlush();
        this.scheduleUnrequestedFlush();
      } else {
        this.sendFunctionResponse(id, content);
      }
      return true;
    }
    if (item.type === 'message' && item.role === 'user') {
      const parts = Array.isArray(item.content) ? item.content : [];
      if (parts.some((part) => part?.type !== 'input_text')) return false;
      const text = parts
        .map((part) => part.text || '')
        .join('\n')
        .trim();
      if (!text) return false;
      // Deepgram refuses injections while the agent speaks; the turns owner
      // asks for this reply (response.create) once the current one is done.
      if (this.open || this.playbackActive) this.heldUserText = text;
      else this.sendUserText(text);
      return true;
    }
    // System notes (pointer_context, annotation outcomes) cannot be added
    // silently to a Deepgram conversation.
    return false;
  }

  sendUserText(text) {
    this.dropAgent = false;
    this.replyExpected = true;
    this.send({ type: 'InjectUserMessage', content: text });
  }

  /** Flush answered calls once every call is answered and a reply was asked for. */
  maybeFlush({ force = false } = {}) {
    const request = this.pendingRequest;
    if (!request) return;
    const unanswered = [...request.ids].filter(
      (id) => !request.answered.has(id),
    );
    if (unanswered.length) return;
    if (!this.createRequested && !force) return;
    const requested = this.createRequested;
    this.pendingRequest = null;
    this.createRequested = null;
    if (this.flushTimer) this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const entries = [...request.answered];
    entries.forEach(([id, content], index) => {
      const guidance =
        requested?.instructions && index === entries.length - 1
          ? `\n\n(Guidance for your spoken reply: ${requested.instructions})`
          : '';
      this.sendFunctionResponse(id, content + guidance);
    });
    if (requested) {
      this.dropAgent = false;
      this.armWatchdog();
    }
    this.maybeSendHeldText();
  }

  /**
   * Superseded calls get outputs but no response.create: once every call is
   * answered and still no reply was asked for, flush them anyway.
   */
  scheduleUnrequestedFlush() {
    if (this.flushTimer) this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const request = this.pendingRequest;
    if (!request || this.createRequested) return;
    if ([...request.ids].some((id) => !request.answered.has(id))) return;
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = null;
      this.maybeFlush({ force: true });
    }, UNREQUESTED_OUTPUT_FLUSH_MS);
  }

  sendFunctionResponse(id, content) {
    this.send({
      type: 'FunctionCallResponse',
      id,
      name: this.callNames.get(id) || '',
      content,
    });
  }

  dispose() {
    this.clearWatchdog();
    if (this.flushTimer) this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}
