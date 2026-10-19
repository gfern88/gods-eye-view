import { t } from '../i18n/index.js';
import { DeepgramTranslator } from './deepgramProtocol.js';

export const DEEPGRAM_AGENT_PATH = '/api/deepgram/agent';
export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;
/** Close a session nobody has spoken to for this long: Deepgram bills per minute. */
export const IDLE_CLOSE_MS = 5 * 60 * 1000;
/** Give up when Deepgram has not applied the Settings by then. */
export const CONNECT_TIMEOUT_MS = 15_000;

// Downsample the mic to 16 kHz mono linear16 in ~40 ms frames. Muted tracks
// deliver zeros, exactly like the WebRTC path, so push-to-talk is unchanged.
const CAPTURE_WORKLET = `
class GevPcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = sampleRate / ${INPUT_SAMPLE_RATE};
    this.frame = new Int16Array(${INPUT_SAMPLE_RATE / 25});
    this.filled = 0;
    this.carry = 0;
    this.port.onmessage = (e) => { this.silent = Boolean(e.data && e.data.silent); };
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let pos = this.carry;
    while (pos < channel.length) {
      const start = Math.floor(pos);
      const end = Math.min(channel.length, Math.floor(pos + this.ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += channel[i];
      const v = this.silent ? 0 : sum / Math.max(1, end - start);
      this.frame[this.filled++] = Math.max(-1, Math.min(1, v)) * 0x7fff;
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame.buffer.slice(0));
        this.filled = 0;
      }
      pos += this.ratio;
    }
    this.carry = pos - channel.length;
    return true;
  }
}
registerProcessor('gev-pcm-capture', GevPcmCapture);
`;

function agentUrl(location = window.location) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${DEEPGRAM_AGENT_PATH}`;
}

/**
 * The Deepgram counterpart of RealtimeConnection: same public surface, so the
 * controller's other owners (turns, radio, viewport, input, cost) are unchanged.
 * Audio flows over a same-origin WebSocket to the server's agent proxy; `dc`
 * is a data-channel-shaped view of that socket that only reads 'open' once
 * Deepgram has applied the server's Settings.
 */
export class DeepgramConnection {
  constructor({
    readLifetimeSignal,
    readBackend,
    readStatus,
    input,
    cost,
    operations,
  }) {
    Object.assign(
      this,
      { readLifetimeSignal, readBackend, readStatus, input, cost },
      operations,
    );
    this.supportsVision = false;
    this.connectionAbort = null;
    this.pc = null;
    this.dc = null;
    this.ws = null;
    this.stream = null;
    this.audioEl = null;
    this.audioContext = null;
    this.workletUrl = null;
    this.playback = null;
    this.translator = null;
    this.idleTimer = null;
    this.connectTimer = null;
    this.startEpoch = 0;
    this.disconnectGraceTimer = null;
    this._tearingDown = false;
  }
  get lifetimeSignal() {
    return this.readLifetimeSignal();
  }
  get status() {
    return this.readStatus();
  }

  async start({ pushToTalk = false } = {}) {
    if (this.isActive() || this.lifetimeSignal?.aborted) return;
    this.pauseRadioForVoice();
    const pushToTalkKeyHeld = pushToTalk && this.input.pushToTalkKeyHeld;
    const spaceKeyHeld = this.input.spaceKeyHeld;
    this.stop({ preserveStatus: true });
    this.input.pushToTalkMode = pushToTalk;
    this.input.pushToTalkKeyHeld = pushToTalkKeyHeld;
    this.input.spaceKeyHeld = spaceKeyHeld;
    const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
    if (
      !window.WebSocket ||
      !AudioContextImpl ||
      typeof AudioWorkletNode === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      this.setStatus('error', t('WebRTC microphone support unavailable'));
      return;
    }
    if (this.lifetimeSignal?.aborted) return;
    const epoch = ++this.startEpoch;
    this.connectionAbort?.abort();
    this.connectionAbort = new AbortController();
    const signal = AbortSignal.any(
      [this.connectionAbort.signal, this.lifetimeSignal].filter(Boolean),
    );
    this.cost.prepareSession();
    this.syncCostUi();
    this.setStatus('connecting', t('Requesting microphone'));
    this.debugLog('session.starting', { epoch, provider: 'deepgram' });
    let localStream = null;
    // Created before the first await, inside the click/keypress that started
    // voice, so Safari lets it run.
    let localContext = new AudioContextImpl();
    this.audioContext = localContext;
    localContext.resume?.().catch?.(() => {});
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      if (this.abandonStart(epoch, { localStream, localContext })) return;
      this.stream = localStream;
      this.setMicrophoneEnabled(
        !this.input.pushToTalkMode || this.input.pushToTalkKeyHeld,
      );
      this.startVoiceVisualizer(localStream);

      this.workletUrl ||= URL.createObjectURL(
        new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }),
      );
      await localContext.audioWorklet.addModule(this.workletUrl);
      if (this.abandonStart(epoch, { localStream, localContext })) return;
      await localContext.resume?.();
      if (this.abandonStart(epoch, { localStream, localContext })) return;

      const capture = new AudioWorkletNode(localContext, 'gev-pcm-capture');
      const sink = localContext.createGain();
      sink.gain.value = 0;
      localContext.createMediaStreamSource(localStream).connect(capture);
      capture.connect(sink).connect(localContext.destination);

      const output = localContext.createGain();
      const tap = localContext.createMediaStreamDestination();
      output.connect(localContext.destination);
      output.connect(tap);
      this.playback = { capture, output, sources: new Set(), nextTime: 0 };
      this.startAssistantVoiceVisualizer(tap.stream);

      const ws = new WebSocket(agentUrl());
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const owns = () =>
        epoch === this.startEpoch && this.ws === ws && !signal.aborted;
      const channel = this.createChannel(ws);
      this.dc = channel;
      this.translator = new DeepgramTranslator({
        // Synthesized events run after the current call stack, never inside
        // a turns-owner method that is mid-update.
        emit: (event) =>
          queueMicrotask(() => {
            if (owns() && this.dc === channel && channel.readyState === 'open')
              this.handleRealtimeEvent({ data: JSON.stringify(event) });
          }),
        send: (message) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify(message));
        },
        stopPlayback: () => this.stopPlayback(),
        log: (name, detail) => this.debugLog(name, detail),
      });
      capture.port.onmessage = (event) => {
        if (owns() && channel.readyState === 'open') ws.send(event.data);
      };

      ws.addEventListener('message', (event) => {
        if (!owns()) return;
        if (typeof event.data !== 'string') {
          if (channel.readyState === 'open') this.playAgentAudio(event.data);
          return;
        }
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'SettingsApplied') {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
          channel.state = 'open';
          const detail = this.input.pushToTalkMode
            ? this.input.pushToTalkKeyHeld
              ? t('Release Space to send')
              : t('Hold Space to talk')
            : t('Ask or command');
          this.setStatus('listening', detail);
          this.resetIdle();
          this.debugLog('deepgram.settings_applied');
          return;
        }
        if (message.type === 'Welcome') return;
        // Deepgram errors end the session: tear down at once so a dead
        // agent never leaves the mic live and the minute meter running.
        if (message.type === 'Error') {
          this.fatalError(
            `Deepgram agent: ${message.description || message.code || 'error'}`,
            null,
            {
              code: message.code || null,
              ...this.connectionDiagnostics(channel),
            },
          );
          return;
        }
        if (
          message.type === 'UserStartedSpeaking' ||
          message.type === 'FunctionCallRequest'
        )
          this.resetIdle();
        if (channel.readyState === 'open')
          this.translator.handleServerMessage(message);
      });
      ws.addEventListener('error', (event) => {
        if (this._tearingDown || !owns()) return;
        this.fatalError(
          'Deepgram voice connection',
          event,
          this.connectionDiagnostics(channel),
        );
      });
      ws.addEventListener('close', (event) => {
        if (this._tearingDown || !owns()) return;
        channel.state = 'closed';
        if (this.status === 'error') {
          this.stop({ preserveStatus: true });
        } else if (this.status !== 'idle') {
          this.fatalError(
            `Deepgram voice connection closed${event.reason ? `: ${event.reason}` : ''}`,
            null,
            this.connectionDiagnostics(channel),
          );
        }
      });
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null;
        if (owns() && channel.readyState !== 'open')
          this.fatalError(
            'Deepgram voice connection timed out',
            null,
            this.connectionDiagnostics(channel),
          );
      }, CONNECT_TIMEOUT_MS);
    } catch (error) {
      if (epoch !== this.startEpoch) {
        releaseLocals({ localStream, localContext });
        return;
      }
      const diagnostics = this.connectionDiagnostics();
      this.stop({ preserveStatus: true });
      this.reportError('Deepgram voice connection', error, diagnostics);
    }
  }

  /** A data-channel-shaped view of the agent socket; new object per session. */
  createChannel(ws) {
    const channel = {
      state: 'connecting',
      get readyState() {
        return this.state;
      },
      send: () => {
        throw new Error('Use sendRealtimeEvent');
      },
      close: () => {
        channel.state = 'closed';
        try {
          ws.close(1000, 'client stop');
        } catch {
          /* already closed */
        }
      },
    };
    return channel;
  }

  playAgentAudio(buffer) {
    const playback = this.playback;
    const context = this.audioContext;
    if (!playback || !context || !buffer?.byteLength) return;
    if (!this.translator.acceptAudio()) return;
    // Open mic stays quiet while the agent talks (OpenAI runs with
    // interrupt_response:false); a Space hold barges in explicitly.
    playback.capture.port.postMessage({
      silent: !this.input.pushToTalkKeyHeld,
    });
    const pcm = new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2));
    const audio = context.createBuffer(1, pcm.length, OUTPUT_SAMPLE_RATE);
    const samples = audio.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;
    const source = context.createBufferSource();
    source.buffer = audio;
    source.connect(playback.output);
    const startAt = Math.max(context.currentTime + 0.02, playback.nextTime);
    playback.nextTime = startAt + audio.duration;
    playback.sources.add(source);
    source.onended = () => {
      if (!playback.sources.delete(source) || playback.sources.size) return;
      this.onPlaybackDrained();
    };
    source.start(startAt);
  }

  onPlaybackDrained() {
    this.playback?.capture.port.postMessage({ silent: false });
    this.translator?.playbackDrained();
  }

  stopPlayback() {
    const playback = this.playback;
    if (!playback) return;
    for (const source of playback.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* not started */
      }
    }
    playback.sources.clear();
    playback.nextTime = 0;
    playback.capture.port.postMessage({ silent: false });
  }

  resetIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.dc) return;
      this.debugLog('deepgram.idle_close', { idleMs: IDLE_CLOSE_MS });
      this.stop();
    }, IDLE_CLOSE_MS);
  }

  abandonStart(epoch, resources) {
    if (epoch === this.startEpoch) return false;
    if (resources.localStream && this.stream === resources.localStream)
      this.stream = null;
    if (resources.localContext && this.audioContext === resources.localContext)
      this.audioContext = null;
    releaseLocals(resources);
    this.debugLog('session.start.abandoned', {
      epoch,
      currentEpoch: this.startEpoch,
    });
    return true;
  }

  // WebSocket drops are terminal (close handler); there is no ICE-style blip.
  handleConnectionStateChange() {}

  clearDisconnectGrace() {
    if (this.disconnectGraceTimer) clearTimeout(this.disconnectGraceTimer);
    this.disconnectGraceTimer = null;
  }

  sendRealtimeEvent(message, logEventName = 'client.event') {
    if (!this.dc || this.dc.readyState !== 'open' || !this.translator)
      return false;
    this.debugLog(logEventName, { type: message?.type || null, message });
    if (
      message?.type === 'conversation.item.create' &&
      message.item?.role === 'user'
    )
      this.resetIdle();
    try {
      return this.translator.handleClientEvent(message);
    } catch (error) {
      this.debugLog('client.send.failed', {
        logEventName,
        type: message?.type || null,
        error: error?.message || String(error),
      });
      return false;
    }
  }

  invalidate() {
    this.startEpoch++;
    this.connectionAbort?.abort();
    this.connectionAbort = null;
  }

  closeTransport() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.translator?.dispose();
    this.translator = null;
    this.stopPlayback();
    if (this.dc) {
      this.dc.close();
      this.dc = null;
    }
    this.ws = null;
    this._tearingDown = false;
  }

  releaseMedia() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close?.().catch?.(() => {});
      this.audioContext = null;
    }
    this.playback = null;
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
  }

  beginTeardown() {
    this._tearingDown = true;
  }
}

function releaseLocals({ localStream = null, localContext = null } = {}) {
  try {
    localStream?.getTracks().forEach((track) => track.stop());
  } catch {
    /* no-op */
  }
  try {
    localContext?.close?.();
  } catch {
    /* no-op */
  }
}
