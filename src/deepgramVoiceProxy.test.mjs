import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import {
  admitAgentUpgrade,
  relayAgentSession,
} from '../server/providers/deepgram.js';

const savedTrusted = process.env.GEV_TRUSTED_PROXIES;
afterEach(() => {
  if (savedTrusted === undefined) delete process.env.GEV_TRUSTED_PROXIES;
  else process.env.GEV_TRUSTED_PROXIES = savedTrusted;
});

const upgrade = (headers, peer = '127.0.0.1') => ({
  socket: { remoteAddress: peer },
  headers: {
    host: 'localhost:4173',
    origin: 'http://localhost:4173',
    ...headers,
  },
});
const admit = (req, overrides = {}) =>
  admitAgentUpgrade(req, {
    allowedHosts: ['localhost', 'god.gf88.dev'],
    env: { DEEPGRAM_API_KEY: 'fixture' },
    limiter: null,
    active: { total: 0, byClient: new Map() },
    ...overrides,
  });

test('upgrade gate: same-origin browser handshake is admitted', () => {
  assert.equal(admit(upgrade({})), null);
});

test('upgrade gate refuses foreign hosts, missing or foreign origins', () => {
  assert.equal(admit(upgrade({ host: 'evil.example' }))[0], 403);
  assert.deepEqual(admit(upgrade({ origin: '' })), [403, 'Origin required']);
  assert.equal(admit(upgrade({ origin: 'https://evil.example' }))[0], 403);
});

test('upgrade gate: proxied handshakes need a trusted proxy and its scheme', () => {
  const proxied = upgrade(
    {
      host: 'god.gf88.dev',
      origin: 'https://god.gf88.dev',
      'x-forwarded-for': '1.2.3.4',
      'x-forwarded-proto': 'https',
      'cf-connecting-ip': '1.2.3.4',
    },
    '10.1.1.35',
  );
  delete process.env.GEV_TRUSTED_PROXIES;
  assert.equal(admit(proxied)[0], 403);
  process.env.GEV_TRUSTED_PROXIES = '10.1.1.35';
  assert.equal(admit(proxied), null);
});

test('upgrade gate: missing key, rate limit and session caps', () => {
  assert.deepEqual(admit(upgrade({}), { env: {} }), [
    503,
    'DEEPGRAM_API_KEY is not set',
  ]);
  assert.equal(admit(upgrade({}), { limiter: () => false })[0], 429);
  const full = { total: 4, byClient: new Map() };
  assert.equal(admit(upgrade({}), { active: full })[0], 429);
  const perClient = { total: 2, byClient: new Map([['127.0.0.1', 2]]) };
  assert.equal(admit(upgrade({}), { active: perClient })[0], 429);
});

async function relayFixture(t) {
  const upstreamReceived = [];
  let upstreamSocket = null;
  const upstream = new WebSocketServer({ port: 0 });
  let authorization = null;
  upstream.on('connection', (socket, req) => {
    authorization = req.headers.authorization;
    upstreamSocket = socket;
    socket.on('message', (data, isBinary) => {
      upstreamReceived.push(isBinary ? 'binary' : JSON.parse(String(data)));
      if (!isBinary && JSON.parse(String(data)).type === 'Settings') {
        socket.send(JSON.stringify({ type: 'SettingsApplied' }));
      }
    });
    socket.send(JSON.stringify({ type: 'Welcome', request_id: 'r1' }));
  });
  await once(upstream, 'listening');
  const front = new WebSocketServer({ port: 0, maxPayload: 65536 });
  let closed = false;
  front.on('connection', (client) => {
    relayAgentSession(client, {
      WebSocket,
      apiKey: 'fixture-key',
      settings: { type: 'Settings', agent: {} },
      url: `ws://127.0.0.1:${upstream.address().port}`,
      onClose: () => {
        closed = true;
      },
    });
  });
  await once(front, 'listening');
  const browser = new WebSocket(`ws://127.0.0.1:${front.address().port}`);
  const browserReceived = [];
  browser.on('message', (data, isBinary) =>
    browserReceived.push(isBinary ? 'binary' : JSON.parse(String(data))),
  );
  await once(browser, 'open');
  t.after(() => {
    browser.terminate();
    front.close();
    upstream.close();
  });
  const until = async (predicate) => {
    for (let i = 0; i < 100 && !predicate(); i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(predicate(), 'condition not reached');
  };
  return {
    browser,
    browserReceived,
    upstreamReceived,
    until,
    upstreamSocket: () => upstreamSocket,
    authorization: () => authorization,
    closed: () => closed,
  };
}

test('relay sends server Settings on Welcome and filters client messages', async (t) => {
  const f = await relayFixture(t);
  await f.until(() =>
    f.browserReceived.some((m) => m.type === 'SettingsApplied'),
  );
  assert.equal(f.authorization(), 'Token fixture-key');
  assert.deepEqual(f.upstreamReceived[0], { type: 'Settings', agent: {} });
  f.browser.send(
    JSON.stringify({ type: 'Settings', agent: { think: 'hijack' } }),
  );
  f.browser.send(JSON.stringify({ type: 'UpdatePrompt', prompt: 'hijack' }));
  f.browser.send(
    JSON.stringify({ type: 'InjectUserMessage', content: 'hello' }),
  );
  f.browser.send(Buffer.alloc(640));
  f.browser.send(
    JSON.stringify({
      type: 'FunctionCallResponse',
      id: 'c1',
      name: 'x',
      content: '{}',
    }),
  );
  await f.until(() => f.upstreamReceived.length >= 4);
  assert.deepEqual(
    f.upstreamReceived.map((m) => (m === 'binary' ? m : m.type)),
    ['Settings', 'InjectUserMessage', 'binary', 'FunctionCallResponse'],
  );
  f.upstreamSocket().send(Buffer.alloc(480));
  await f.until(() => f.browserReceived.includes('binary'));
});

test('relay closes the browser when the upstream closes', async (t) => {
  const f = await relayFixture(t);
  await f.until(() =>
    f.browserReceived.some((m) => m.type === 'SettingsApplied'),
  );
  const closing = once(f.browser, 'close');
  f.upstreamSocket().close(4001, 'bye');
  const [code] = await closing;
  assert.equal(code, 4001);
  assert.equal(f.closed(), true);
});

test('relay drops oversized client frames by closing', async (t) => {
  const f = await relayFixture(t);
  await f.until(() =>
    f.browserReceived.some((m) => m.type === 'SettingsApplied'),
  );
  const closing = once(f.browser, 'close');
  f.browser.send(Buffer.alloc(70 * 1024));
  const [code] = await closing;
  assert.equal(code, 1009);
});
