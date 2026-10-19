import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeepgramTranslator,
  REPLY_WATCHDOG_MS,
  UNREQUESTED_OUTPUT_FLUSH_MS,
} from './deepgramProtocol.js';
import { GevRealtimeController } from './realtimeController.js';
import { configuredVoiceProvider } from './commands.js';
import { createRealtimeSession } from './realtimeSession.js';
import {
  buildDeepgramSettings,
  deepgramFunctions,
  resolveThink,
  resolveVoiceProvider,
} from '../../server/providers/deepgram/settings.js';

function fakeTimers() {
  let clock = 0;
  let next = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay = 0) {
      const id = next++;
      timers.set(id, { callback, due: clock + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = clock + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        timers.delete(due[0]);
        clock = due[1].due;
        due[1].callback();
      }
      clock = end;
    },
  };
}

function translatorFixture() {
  const emitted = [];
  const sent = [];
  let stops = 0;
  const timers = fakeTimers();
  const translator = new DeepgramTranslator({
    emit: (event) => emitted.push(event),
    send: (message) => sent.push(message),
    stopPlayback: () => stops++,
    timers,
  });
  return { translator, emitted, sent, timers, stops: () => stops };
}

const types = (events) => events.map((event) => event.type);

// ---- settings -------------------------------------------------------------

test('voice provider: forced value wins, else Deepgram when keyed', () => {
  assert.equal(resolveVoiceProvider({}), 'openai');
  assert.equal(resolveVoiceProvider({ DEEPGRAM_API_KEY: 'k' }), 'deepgram');
  assert.equal(
    resolveVoiceProvider({ DEEPGRAM_API_KEY: 'k', VOICE_PROVIDER: 'OpenAI' }),
    'openai',
  );
  assert.equal(
    resolveVoiceProvider({ VOICE_PROVIDER: 'deepgram' }),
    'openai',
    'forced but unkeyed Deepgram falls back',
  );
});

test('think provider defaults per provider and rejects unknown ones', () => {
  assert.deepEqual(resolveThink({}), {
    provider: 'open_ai',
    model: 'gpt-4.1-mini',
    ownKey: false,
  });
  assert.equal(
    resolveThink({ DEEPGRAM_THINK_PROVIDER: 'anthropic' }).model,
    'claude-haiku-4-5',
  );
  assert.equal(
    resolveThink({ DEEPGRAM_THINK_PROVIDER: 'openai' }).provider,
    'open_ai',
  );
  assert.throws(
    () => resolveThink({ DEEPGRAM_THINK_PROVIDER: 'gemini' }),
    /open_ai or anthropic/,
  );
});

test('settings carry prompt, client-side functions and own-key endpoints', () => {
  const tools = [
    {
      type: 'function',
      name: 'fly_to_location',
      description: 'Fly',
      parameters: { type: 'object' },
    },
  ];
  const settings = buildDeepgramSettings({
    env: {
      DEEPGRAM_THINK_PROVIDER: 'anthropic',
      DEEPGRAM_THINK_MODEL: 'claude-sonnet-4-6',
      DEEPGRAM_THINK_API_KEY: 'sk-ant-fixture',
    },
    tools,
  });
  assert.equal(settings.type, 'Settings');
  assert.deepEqual(settings.audio.input, {
    encoding: 'linear16',
    sample_rate: 16000,
  });
  assert.equal(settings.agent.think.provider.type, 'anthropic');
  assert.equal(settings.agent.think.provider.model, 'claude-sonnet-4-6');
  assert.equal(
    settings.agent.think.endpoint.headers['x-api-key'],
    'sk-ant-fixture',
  );
  assert.match(settings.agent.think.prompt, /GEV Voice Control/);
  assert.match(settings.agent.think.prompt, /never receive screenshots/);
  assert.ok(settings.agent.think.prompt.length < 25000);
  assert.deepEqual(settings.agent.think.functions, [
    {
      name: 'fly_to_location',
      description: 'Fly',
      parameters: { type: 'object' },
    },
  ]);
  assert.equal(
    buildDeepgramSettings({ env: {} }).agent.think.endpoint,
    undefined,
  );
  assert.deepEqual(deepgramFunctions([{ name: 'x' }])[0].parameters, {
    type: 'object',
    properties: {},
  });
});

test('client reads the provider meta and hides cost controls for Deepgram', () => {
  const doc = (content) => ({
    querySelector: () => (content ? { getAttribute: () => content } : null),
  });
  assert.equal(configuredVoiceProvider(doc('deepgram')), 'deepgram');
  assert.equal(configuredVoiceProvider(doc('other')), 'openai');
  assert.equal(configuredVoiceProvider(doc(null)), 'openai');
  let options = null;
  const session = createRealtimeSession({
    provider: 'deepgram',
    createController: (o) => {
      options = o;
      return { ui: {} };
    },
  });
  assert.equal(session.capabilities.costControls, false);
  assert.equal(typeof options.createConnection, 'function');
  assert.equal(
    createRealtimeSession({ createController: () => ({ ui: {} }) }).capabilities
      .costControls,
    true,
  );
});

// ---- translator -------------------------------------------------------------

test('a spoken reply opens one response and closes it after playback drains', () => {
  const { translator, emitted } = translatorFixture();
  translator.handleServerMessage({
    type: 'ConversationText',
    role: 'user',
    content: 'hi',
  });
  translator.handleServerMessage({ type: 'AgentThinking', content: '' });
  translator.handleServerMessage({
    type: 'ConversationText',
    role: 'assistant',
    content: 'Hello.',
  });
  assert.equal(translator.acceptAudio(), true);
  assert.equal(translator.acceptAudio(), true);
  translator.handleServerMessage({ type: 'AgentAudioDone' });
  assert.equal(translator.open?.id !== undefined, true, 'still playing');
  translator.playbackDrained();
  assert.deepEqual(types(emitted), [
    'input_audio_buffer.speech_stopped',
    'conversation.item.input_audio_transcription.completed',
    'response.created',
    'response.output_audio_transcript.delta',
    'response.output_audio_transcript.done',
    'output_audio_buffer.started',
    'output_audio_buffer.stopped',
    'response.done',
  ]);
  assert.equal(emitted.at(-1).response.status, 'completed');
  assert.equal(translator.open, null);
});

test('tool results wait for response.create and carry its instructions', () => {
  const { translator, emitted, sent } = translatorFixture();
  translator.handleServerMessage({
    type: 'FunctionCallRequest',
    functions: [
      {
        id: 'c1',
        name: 'fly_to_location',
        arguments: '{"query":"Perth"}',
        client_side: true,
      },
      {
        id: 'c2',
        name: 'set_layer',
        arguments: { id: 'flights' },
        client_side: true,
      },
    ],
  });
  assert.deepEqual(types(emitted), [
    'response.created',
    'response.output_item.done',
    'response.output_item.done',
    'response.done',
  ]);
  assert.equal(emitted[2].item.arguments, '{"id":"flights"}');
  translator.handleClientEvent({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: 'c1',
      output: '{"ok":true}',
    },
  });
  // Asked for a reply before the second call finished: still held.
  translator.handleClientEvent({
    type: 'response.create',
    response: { instructions: 'Say done.' },
  });
  assert.equal(sent.length, 0);
  translator.handleClientEvent({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: 'c2',
      output: '{"ok":true}',
    },
  });
  assert.deepEqual(sent, [
    {
      type: 'FunctionCallResponse',
      id: 'c1',
      name: 'fly_to_location',
      content: '{"ok":true}',
    },
    {
      type: 'FunctionCallResponse',
      id: 'c2',
      name: 'set_layer',
      content: '{"ok":true}\n\n(Guidance for your spoken reply: Say done.)',
    },
  ]);
  assert.equal(translator.replyExpected, true);
});

test('outputs with no response.create (superseded calls) still reach Deepgram', () => {
  const { translator, sent, timers } = translatorFixture();
  translator.handleServerMessage({
    type: 'FunctionCallRequest',
    functions: [
      { id: 'c1', name: 'zoom_to_globe', arguments: '{}', client_side: true },
    ],
  });
  translator.handleClientEvent({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: 'c1',
      output: '{"superseded":true}',
    },
  });
  assert.equal(sent.length, 0);
  timers.advance(UNREQUESTED_OUTPUT_FLUSH_MS);
  assert.equal(sent[0].type, 'FunctionCallResponse');
  assert.equal(translator.replyExpected, false);
});

test('a reply that never comes is closed by the watchdog', () => {
  const { translator, emitted, sent, timers } = translatorFixture();
  translator.handleClientEvent({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'zoom out' }],
    },
  });
  assert.deepEqual(sent, [{ type: 'InjectUserMessage', content: 'zoom out' }]);
  translator.handleClientEvent({ type: 'response.create' });
  assert.equal(emitted.length, 0);
  timers.advance(REPLY_WATCHDOG_MS);
  assert.deepEqual(types(emitted), ['response.created', 'response.done']);
});

test('a real reply cancels the watchdog', () => {
  const { translator, emitted, timers } = translatorFixture();
  translator.handleClientEvent({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hi' }],
    },
  });
  translator.handleClientEvent({ type: 'response.create' });
  translator.handleServerMessage({ type: 'AgentStartedSpeaking' });
  timers.advance(REPLY_WATCHDOG_MS);
  assert.deepEqual(types(emitted), ['response.created']);
});

test('response.create with nothing outstanding answers at once', () => {
  const { translator, emitted } = translatorFixture();
  assert.equal(translator.handleClientEvent({ type: 'response.create' }), true);
  assert.deepEqual(types(emitted), ['response.created', 'response.done']);
});

test('unsupported client events report failure', () => {
  const { translator, sent } = translatorFixture();
  assert.equal(
    translator.handleClientEvent({
      type: 'response.create',
      response: { conversation: 'none' },
    }),
    false,
  );
  assert.equal(
    translator.handleClientEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: '{}' }],
      },
    }),
    false,
  );
  assert.equal(
    translator.handleClientEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'data:' },
        ],
      },
    }),
    false,
  );
  assert.equal(
    translator.handleClientEvent({
      type: 'conversation.item.delete',
      item_id: 'x',
    }),
    true,
  );
  assert.equal(sent.length, 0);
});

test('barge-in: cancel and clear end the response once and drop its remainder', () => {
  const { translator, emitted, stops } = translatorFixture();
  translator.handleServerMessage({ type: 'AgentStartedSpeaking' });
  translator.acceptAudio();
  translator.handleClientEvent({ type: 'response.cancel' });
  translator.handleClientEvent({ type: 'output_audio_buffer.clear' });
  assert.deepEqual(types(emitted), [
    'response.created',
    'output_audio_buffer.started',
    'output_audio_buffer.cleared',
    'response.done',
  ]);
  assert.equal(emitted.at(-1).response.status, 'cancelled');
  assert.equal(stops(), 2);
  assert.equal(
    translator.acceptAudio(),
    false,
    'late audio of the cancelled reply',
  );
  translator.handleServerMessage({
    type: 'FunctionCallRequest',
    functions: [
      { id: 'late', name: 'zoom_to_globe', arguments: '{}', client_side: true },
    ],
  });
  const late = emitted.at(-1);
  assert.equal(late.type, 'response.output_item.done');
  assert.equal(
    late.response_id,
    emitted[0].response.id,
    'belongs to the cancelled response',
  );
});

test('user speech is announced before the interrupted response ends', () => {
  const { translator, emitted } = translatorFixture();
  translator.handleServerMessage({ type: 'AgentThinking' });
  translator.handleServerMessage({ type: 'UserStartedSpeaking' });
  assert.deepEqual(types(emitted), [
    'response.created',
    'input_audio_buffer.speech_started',
    'response.done',
  ]);
  assert.equal(translator.acceptAudio(), true, 'the next reply plays');
});

test('cancelled calls are never answered', () => {
  const { translator, sent, timers } = translatorFixture();
  translator.handleServerMessage({
    type: 'FunctionCallRequest',
    functions: [{ id: 'c1', name: 'x', arguments: '{}', client_side: true }],
  });
  translator.handleServerMessage({
    type: 'FunctionCallCancelled',
    functions: [{ id: 'c1', name: 'x' }],
  });
  translator.handleClientEvent({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: 'c1', output: '{}' },
  });
  timers.advance(UNREQUESTED_OUTPUT_FLUSH_MS);
  assert.equal(sent.length, 0);
});

// ---- integration: real turns owner + translator ----------------------------

const settle = async () => {
  for (let i = 0; i < 6; i++)
    await new Promise((resolve) => setImmediate(resolve));
};

function integrationFixture({
  runner = async (name) => ({ ok: true, action: name }),
} = {}) {
  const timers = fakeTimers();
  const deepgramSent = [];
  const statuses = [];
  let stops = 0;
  const controller = new GevRealtimeController({
    ui: {
      root: {
        dataset: {},
        classList: { remove() {} },
        querySelectorAll: () => [],
      },
      status: { textContent: '' },
      detail: { textContent: '', title: '' },
      errorDetail: { textContent: '' },
    },
    runner,
    debugSink: null,
  });
  const setStatus = controller.setStatus.bind(controller);
  controller.setStatus = (status, detail) => {
    statuses.push(status);
    return setStatus(status, detail);
  };
  const channel = { readyState: 'open', send() {}, close() {} };
  controller.dc = channel;
  const translator = new DeepgramTranslator({
    emit: (event) =>
      queueMicrotask(() => {
        if (controller.dc === channel)
          controller.handleRealtimeEvent({ data: JSON.stringify(event) });
      }),
    send: (message) => deepgramSent.push(message),
    stopPlayback: () => stops++,
    timers,
  });
  controller._connection.sendRealtimeEvent = (message) =>
    channel.readyState === 'open' && translator.handleClientEvent(message);
  const server = async (message) => {
    translator.handleServerMessage(message);
    await settle();
  };
  const speakReply = async (text = 'Done.') => {
    await server({ type: 'AgentStartedSpeaking' });
    await server({
      type: 'ConversationText',
      role: 'assistant',
      content: text,
    });
    translator.acceptAudio();
    await server({ type: 'AgentAudioDone' });
    translator.playbackDrained();
    await settle();
  };
  return {
    controller,
    translator,
    deepgramSent,
    statuses,
    timers,
    server,
    speakReply,
    stops: () => stops,
  };
}

const idle = (controller) => {
  assert.equal(controller.responseActive, false, 'responseActive');
  assert.equal(
    controller.responseCreatePending,
    false,
    'responseCreatePending',
  );
  assert.equal(
    controller.pendingResponseInstructions,
    null,
    'pendingResponseInstructions',
  );
};

test('integration: tool call, held output, spoken reply, back to idle', async () => {
  const calls = [];
  const f = integrationFixture({
    runner: async (name, args) => {
      calls.push([name, args]);
      return { ok: true, action: name };
    },
  });
  await f.server({
    type: 'ConversationText',
    role: 'user',
    content: 'fly to Perth',
  });
  await f.server({
    type: 'FunctionCallRequest',
    functions: [
      {
        id: 'c1',
        name: 'fly_to_location',
        arguments: '{"query":"Perth"}',
        client_side: true,
      },
    ],
  });
  assert.deepEqual(calls, [['fly_to_location', { query: 'Perth' }]]);
  assert.equal(f.deepgramSent.length, 1);
  assert.equal(f.deepgramSent[0].type, 'FunctionCallResponse');
  assert.equal(f.deepgramSent[0].id, 'c1');
  assert.match(f.deepgramSent[0].content, /^\{"ok":true/);
  await f.speakReply('Flying to Perth.');
  idle(f.controller);
  assert.equal(f.statuses.at(-1), 'listening');
  f.timers.advance(REPLY_WATCHDOG_MS);
  await settle();
  idle(f.controller);
});

test('integration: typed command during a reply is answered after it', async () => {
  const f = integrationFixture();
  await f.server({ type: 'AgentStartedSpeaking' });
  f.translator.acceptAudio();
  f.controller.sendTextCommand('zoom out');
  await settle();
  assert.deepEqual(f.deepgramSent, [], 'held while the agent speaks');
  await f.server({ type: 'AgentAudioDone' });
  f.translator.playbackDrained();
  await settle();
  assert.deepEqual(f.deepgramSent, [
    { type: 'InjectUserMessage', content: 'zoom out' },
  ]);
  // The deferred typed turn's response.create now waits for Deepgram's reply.
  assert.equal(f.controller.responseCreatePending, true);
  await f.speakReply('Zooming out.');
  idle(f.controller);
});

test('integration: Space barge-in cancels once; late calls are answered as superseded', async () => {
  const calls = [];
  const f = integrationFixture({
    runner: async (name) => {
      calls.push(name);
      return { ok: true };
    },
  });
  await f.server({ type: 'AgentStartedSpeaking' });
  f.translator.acceptAudio();
  await settle();
  assert.equal(f.controller._turns.bargeIn(), true);
  await settle();
  assert.equal(f.stops() >= 1, true);
  idle(f.controller);
  await f.server({
    type: 'FunctionCallRequest',
    functions: [
      { id: 'late', name: 'zoom_to_globe', arguments: '{}', client_side: true },
    ],
  });
  assert.deepEqual(calls, [], 'superseded call not run');
  f.timers.advance(UNREQUESTED_OUTPUT_FLUSH_MS);
  assert.equal(f.deepgramSent.at(-1).type, 'FunctionCallResponse');
  assert.match(f.deepgramSent.at(-1).content, /superseded/);
});

test('integration: a missing reply cannot wedge the turn', async () => {
  const f = integrationFixture();
  f.controller.sendTextCommand('hello?');
  await settle();
  assert.equal(f.controller.responseCreatePending, true);
  f.timers.advance(REPLY_WATCHDOG_MS);
  await settle();
  idle(f.controller);
});

test('a slow second tool result is never flushed without the first reply request', () => {
  const { translator, sent, timers } = translatorFixture();
  translator.handleServerMessage({
    type: 'FunctionCallRequest',
    functions: [
      { id: 'a', name: 'x', arguments: '{}', client_side: true },
      { id: 'b', name: 'y', arguments: '{}', client_side: true },
    ],
  });
  translator.handleClientEvent({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: 'a', output: '{}' },
  });
  translator.handleClientEvent({
    type: 'response.create',
    response: { instructions: 'A done.' },
  });
  timers.advance(2000);
  assert.equal(sent.length, 0, 'b still running');
  translator.handleClientEvent({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: 'b', output: '{}' },
  });
  assert.deepEqual(
    sent.map((m) => m.id),
    ['a', 'b'],
  );
});

test('response.create during a live reply never closes it', () => {
  const { translator, emitted } = translatorFixture();
  translator.handleServerMessage({ type: 'AgentStartedSpeaking' });
  translator.handleClientEvent({ type: 'response.create' });
  assert.deepEqual(types(emitted), ['response.created']);
});

// ---- DeepgramConnection lifecycle (fake browser) ---------------------------

async function connectionFixture(t) {
  const { DeepgramConnection } = await import('./deepgramConnection.js');
  const saved = {};
  const names = ['window', 'navigator', 'AudioWorkletNode', 'WebSocket'];
  for (const name of names)
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  t.after(() => {
    for (const name of names) {
      if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
      else delete globalThis[name];
    }
  });
  const node = () => ({
    connect: (next) => next || node(),
    port: { postMessage() {} },
    gain: {},
  });
  const contexts = [];
  class FakeAudioContext {
    constructor() {
      this.closed = false;
      this.audioWorklet = { addModule: async () => {} };
      this.destination = node();
      contexts.push(this);
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
    createGain() {
      return node();
    }
    createMediaStreamSource() {
      return node();
    }
    createMediaStreamDestination() {
      return { ...node(), stream: {} };
    }
  }
  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.listeners = {};
      this.sent = [];
      sockets.push(this);
    }
    addEventListener(type, listener) {
      (this.listeners[type] ||= []).push(listener);
    }
    fire(type, event) {
      for (const listener of this.listeners[type] || []) listener(event);
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
  }
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      AudioContext: FakeAudioContext,
      WebSocket: FakeWebSocket,
      location: { protocol: 'https:', host: 'god.gf88.dev' },
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [track],
          getAudioTracks: () => [track],
        }),
      },
    },
  });
  globalThis.AudioWorkletNode = class {
    constructor() {
      Object.assign(this, node());
    }
  };
  globalThis.WebSocket = FakeWebSocket;
  let status = 'idle';
  const errors = [];
  let connection;
  const operations = {
    isActive: () => status !== 'idle' && status !== 'error',
    pauseRadioForVoice() {},
    stop: () => {
      connection.invalidate();
      connection.beginTeardown();
      connection.closeTransport();
      connection.releaseMedia();
      if (status !== 'error') status = 'idle';
    },
    syncCostUi() {},
    setStatus: (next) => {
      status = next;
    },
    debugLog() {},
    connectionDiagnostics: () => ({}),
    setMicrophoneEnabled() {},
    startVoiceVisualizer() {},
    startAssistantVoiceVisualizer() {},
    fatalError: (source) => {
      operations.stop();
      status = 'error';
      errors.push(source);
    },
    reportError: (source) => errors.push(source),
    handleRealtimeEvent() {},
  };
  connection = new DeepgramConnection({
    readLifetimeSignal: () => null,
    readBackend: () => null,
    readStatus: () => status,
    input: {
      pushToTalkMode: false,
      pushToTalkKeyHeld: false,
      spaceKeyHeld: false,
    },
    cost: { prepareSession() {} },
    operations,
  });
  const originalUrl = globalThis.URL;
  globalThis.URL = Object.assign(class extends originalUrl {}, {
    createObjectURL: () => 'blob:fixture',
    revokeObjectURL() {},
  });
  t.after(() => {
    globalThis.URL = originalUrl;
  });
  // Live sessions hold idle/connect timers; end them so the run can exit.
  t.after(() => operations.stop());
  return { connection, sockets, contexts, track, errors, status: () => status };
}

test('connection: opens the same-origin agent socket and goes live on SettingsApplied', async (t) => {
  const f = await connectionFixture(t);
  await f.connection.start();
  assert.equal(f.sockets[0].url, 'wss://god.gf88.dev/api/deepgram/agent');
  assert.equal(f.connection.dc.readyState, 'connecting');
  f.sockets[0].fire('message', {
    data: JSON.stringify({ type: 'SettingsApplied' }),
  });
  assert.equal(f.connection.dc.readyState, 'open');
  assert.equal(f.status(), 'listening');
});

test('connection: a Deepgram Error tears the session down (no live mic)', async (t) => {
  const f = await connectionFixture(t);
  await f.connection.start();
  f.sockets[0].fire('message', {
    data: JSON.stringify({ type: 'SettingsApplied' }),
  });
  f.sockets[0].fire('message', {
    data: JSON.stringify({
      type: 'Error',
      code: 'FAILED_TO_THINK',
      description: 'LLM down',
    }),
  });
  assert.equal(f.status(), 'error');
  assert.match(f.errors[0], /LLM down/);
  assert.equal(f.connection.dc, null, 'dc nulled so the session reads settled');
  assert.equal(f.track.stopped, true);
  assert.equal(f.contexts[0].closed, true);
});

test('connection: an unexpected close is fatal; a stop is not', async (t) => {
  const f = await connectionFixture(t);
  await f.connection.start();
  f.sockets[0].fire('message', {
    data: JSON.stringify({ type: 'SettingsApplied' }),
  });
  f.sockets[0].fire('close', { reason: 'upstream closed' });
  assert.equal(f.status(), 'error');
  assert.match(f.errors[0], /upstream closed/);
});

test('a typed command held across a tool call is still sent', () => {
  const { translator, sent } = translatorFixture();
  translator.handleServerMessage({ type: 'AgentStartedSpeaking' });
  translator.acceptAudio();
  translator.handleClientEvent({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'then zoom out' }],
    },
  });
  translator.handleServerMessage({
    type: 'FunctionCallRequest',
    functions: [{ id: 'c1', name: 'x', arguments: '{}', client_side: true }],
  });
  translator.handleClientEvent({ type: 'response.create' }); // deferred typed turn
  translator.handleClientEvent({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: 'c1', output: '{}' },
  });
  translator.handleClientEvent({
    type: 'response.create',
    response: { instructions: 'ok' },
  });
  assert.deepEqual(
    sent.map((m) => m.type),
    ['FunctionCallResponse'],
  );
  translator.playbackDrained(); // preamble audio finishes
  assert.deepEqual(sent.at(-1), {
    type: 'InjectUserMessage',
    content: 'then zoom out',
  });
});

test('a custom think URL points the open_ai type at a compatible service', () => {
  const think = buildDeepgramSettings({
    env: {
      DEEPGRAM_THINK_URL: 'https://api.cheaperinference.com/v1/',
      DEEPGRAM_THINK_MODEL: 'some-model',
      DEEPGRAM_THINK_API_KEY: 'ci-fixture',
    },
  }).agent.think;
  assert.equal(think.provider.type, 'open_ai');
  assert.equal(think.provider.model, 'some-model');
  assert.deepEqual(think.endpoint, {
    url: 'https://api.cheaperinference.com/v1/chat/completions',
    headers: { authorization: 'Bearer ci-fixture' },
  });
  const full = buildDeepgramSettings({
    env: { DEEPGRAM_THINK_URL: 'https://gw.example/v1/chat/completions' },
  }).agent.think.endpoint;
  assert.deepEqual(full, {
    url: 'https://gw.example/v1/chat/completions',
    headers: {},
  });
  assert.throws(
    () =>
      buildDeepgramSettings({
        env: { DEEPGRAM_THINK_URL: 'http://insecure.example/v1' },
      }),
    /https/,
  );
});

test('custom think URL keeps query strings and suits the anthropic type', () => {
  const url = (env) => buildDeepgramSettings({ env }).agent.think.endpoint.url;
  assert.equal(
    url({ DEEPGRAM_THINK_URL: 'https://gw.example/v1/?api-version=1' }),
    'https://gw.example/v1/chat/completions?api-version=1',
  );
  assert.equal(
    url({ DEEPGRAM_THINK_URL: 'https://gw.example/v1/chat/completions?a=b' }),
    'https://gw.example/v1/chat/completions?a=b',
  );
  assert.equal(
    url({
      DEEPGRAM_THINK_PROVIDER: 'anthropic',
      DEEPGRAM_THINK_URL: 'https://gw.example/v1',
    }),
    'https://gw.example/v1/messages',
  );
  assert.throws(
    () => url({ DEEPGRAM_THINK_URL: 'not a url' }),
    /not a valid URL/,
  );
});
