import { createRequire } from 'node:module';
import { admitSameSiteRequest } from '../../src/localRequestGate.mjs';
import { isAllowedHost } from '../../build/allowedHosts.js';
import { makeCostRateLimiter, clientKey } from './common/rate-limit.js';
import { fromTrustedProxy, requestProtocol } from './common/trusted-proxy.js';
import {
  DEEPGRAM_AGENT_URL,
  buildDeepgramSettings,
  resolveVoiceProvider,
} from './deepgram/settings.js';
import { GEV_REALTIME_TOOLS } from './openai/tools.js';

/**
 * Vite plugin: Deepgram Voice Agent proxy at /api/deepgram/agent.
 *
 * The browser streams microphone audio over a same-origin WebSocket; this
 * server holds DEEPGRAM_API_KEY, opens the upstream agent socket, sends the
 * Settings itself (prompt, tools, models) and relays only an allowlist of
 * client messages. HTTP middlewares do not run on upgrades, so the host,
 * same-site and rate-limit gates are applied here.
 */

export const DEEPGRAM_AGENT_PATH = '/api/deepgram/agent';
export const MAX_FRAME_BYTES = 64 * 1024;
const CLIENT_JSON_TYPES = new Set([
  'FunctionCallResponse',
  'KeepAlive',
  'InjectUserMessage',
]);
const MAX_QUEUED_JSON = 16;
const SESSION_MAX_MS = 2 * 60 * 60 * 1000;
const IDLE_MS = 10 * 60 * 1000;

let _ws;
/** Lazily load `ws` so a missing dependency disables only Deepgram voice. */
function wsModule() {
  if (_ws !== undefined) return _ws;
  try {
    _ws = createRequire(import.meta.url)('ws');
  } catch {
    _ws = null;
    console.warn('[Deepgram] `ws` is unavailable; Deepgram voice is off.');
  }
  return _ws;
}

function refuse(socket, status, message) {
  const body = JSON.stringify({ error: message });
  try {
    socket.write(
      `HTTP/1.1 ${status} ${status === 429 ? 'Too Many Requests' : status === 503 ? 'Service Unavailable' : 'Forbidden'}\r\n` +
        'Content-Type: application/json\r\nCache-Control: no-store\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  } catch {
    /* socket already gone */
  }
  socket.destroy();
}

/**
 * Decide whether an upgrade may open a Deepgram session. Pure apart from the
 * limiter it is handed. Returns null when admitted, else [status, message].
 */
export function admitAgentUpgrade(req, { allowedHosts, env, limiter, active }) {
  if (!isAllowedHost(req.headers?.host, allowedHosts)) {
    return [403, 'Host not allowed'];
  }
  // Browsers always send Origin on WebSocket handshakes; requiring it shuts
  // out cross-site pages and origin-less scripts alike.
  if (!String(req.headers?.origin || '').trim()) {
    return [403, 'Origin required'];
  }
  const verdict = admitSameSiteRequest({
    hostHeader: req.headers?.host,
    protocol: requestProtocol(req),
    origin: req.headers?.origin,
    secFetchSite: req.headers?.['sec-fetch-site'],
    proxyHeaders: fromTrustedProxy(req) ? {} : req.headers || {},
  });
  if (!verdict.ok) return [verdict.status, verdict.error];
  if (!String(env.DEEPGRAM_API_KEY || '').trim()) {
    return [503, 'DEEPGRAM_API_KEY is not set'];
  }
  const key = clientKey(req);
  const maxGlobal = Number(env.GEV_DEEPGRAM_MAX_SESSIONS) || 4;
  if (active.total >= maxGlobal || (active.byClient.get(key) || 0) >= 2) {
    return [429, 'Too many voice sessions'];
  }
  if (limiter && !limiter(key)) return [429, 'Too many voice sessions'];
  return null;
}

/**
 * Relay one browser socket to one upstream agent socket.
 * @param {import('ws').WebSocket} client
 * @param {{WebSocket: Function, apiKey: string, settings: object, url?: string, log?: Function, onClose?: Function}} options
 */
export function relayAgentSession(
  client,
  {
    WebSocket,
    apiKey,
    settings,
    url = DEEPGRAM_AGENT_URL,
    log = () => {},
    onClose,
  },
) {
  const upstream = new WebSocket(url, {
    headers: { Authorization: `Token ${apiKey}` },
    maxPayload: 8 * 1024 * 1024,
  });
  let ready = false;
  let closed = false;
  const queued = [];
  let idleTimer = null;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => close(4000, 'idle'), IDLE_MS);
  };
  const lifetime = setTimeout(
    () => close(4000, 'session limit'),
    SESSION_MAX_MS,
  );

  function close(code = 1000, reason = '') {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    clearTimeout(lifetime);
    for (const socket of [client, upstream]) {
      try {
        if (socket.readyState === 0) socket.terminate?.();
        else socket.close(code, reason.slice(0, 120));
      } catch {
        /* already closed */
      }
    }
    onClose?.();
  }

  upstream.on('message', (data, isBinary) => {
    if (closed) return;
    if (!isBinary) {
      let message = null;
      try {
        message = JSON.parse(String(data));
      } catch {
        /* forwarded as-is below */
      }
      if (message?.type === 'Welcome') {
        upstream.send(JSON.stringify(settings));
      } else if (message?.type === 'SettingsApplied') {
        ready = true;
        for (const frame of queued.splice(0)) upstream.send(frame);
      } else if (message?.type === 'UserStartedSpeaking') {
        resetIdle();
      } else if (message?.type === 'Error') {
        log('upstream.error', {
          code: message.code,
          description: message.description,
        });
      }
    }
    if (client.readyState === 1) client.send(data, { binary: isBinary });
  });
  upstream.on('close', (code, reason) => {
    log('upstream.close', { code, reason: String(reason || '') });
    close(
      code >= 4000 && code < 5000 ? code : 1011,
      String(reason || 'upstream closed'),
    );
  });
  upstream.on('error', (error) => {
    log('upstream.socket_error', { error: error?.message || String(error) });
    close(1011, 'upstream error');
  });

  client.on('message', (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      // Audio before SettingsApplied is dropped: Deepgram refuses it.
      if (ready && upstream.readyState === 1)
        upstream.send(data, { binary: true });
      return;
    }
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!CLIENT_JSON_TYPES.has(message?.type)) {
      log('client.dropped', { type: String(message?.type || '').slice(0, 40) });
      return;
    }
    if (message.type !== 'KeepAlive') resetIdle();
    const frame = JSON.stringify(message);
    if (ready && upstream.readyState === 1) upstream.send(frame);
    else if (queued.length < MAX_QUEUED_JSON) queued.push(frame);
  });
  client.on('close', () => close(1000, 'client closed'));
  client.on('error', () => close(1011, 'client error'));
  resetIdle();
  return { close };
}

function deepgramVoiceProxy({
  realtime = {},
  annotationGuidance,
  env = process.env,
} = {}) {
  const tools = realtime.tools || GEV_REALTIME_TOOLS;
  const active = { total: 0, byClient: new Map() };
  let limiter = null;

  function install(httpServer, allowedHosts) {
    if (!httpServer) return;
    const sessions = new Set();
    let wss = null;
    httpServer.on('upgrade', (req, socket, head) => {
      let pathname = '';
      try {
        pathname = new URL(req.url || '', 'http://local').pathname;
      } catch {
        return;
      }
      if (pathname !== DEEPGRAM_AGENT_PATH) return; // Vite HMR and others
      const ws = wsModule();
      if (!ws) return refuse(socket, 503, 'Deepgram voice unavailable');
      limiter ??= makeCostRateLimiter(env.GEV_RATELIMIT_DEEPGRAM_PER_MIN, 10);
      const refused = admitAgentUpgrade(req, {
        allowedHosts,
        env,
        limiter,
        active,
      });
      if (refused) return refuse(socket, ...refused);
      let settings;
      try {
        settings = buildDeepgramSettings({ env, tools, annotationGuidance });
      } catch (error) {
        return refuse(socket, 503, error.message);
      }
      wss ||= new ws.WebSocketServer({
        noServer: true,
        maxPayload: MAX_FRAME_BYTES,
      });
      const key = clientKey(req);
      wss.handleUpgrade(req, socket, head, (client) => {
        active.total++;
        active.byClient.set(key, (active.byClient.get(key) || 0) + 1);
        const session = relayAgentSession(client, {
          WebSocket: ws.WebSocket,
          apiKey: String(env.DEEPGRAM_API_KEY).trim(),
          settings,
          log: (event, detail) =>
            console.log(`[Deepgram] ${event}`, JSON.stringify(detail)),
          onClose: () => {
            sessions.delete(session);
            active.total--;
            const left = (active.byClient.get(key) || 1) - 1;
            if (left > 0) active.byClient.set(key, left);
            else active.byClient.delete(key);
          },
        });
        sessions.add(session);
      });
    });
    httpServer.once('close', () => {
      for (const session of [...sessions])
        session.close(1001, 'server closing');
      wss?.close();
    });
  }

  const providerMeta = () => [
    {
      tag: 'meta',
      attrs: { name: 'gev-voice-provider', content: resolveVoiceProvider(env) },
      injectTo: 'head',
    },
  ];

  return {
    name: 'deepgram-voice-proxy',
    transformIndexHtml: providerMeta,
    configureServer(server) {
      install(server.httpServer, server.config.server.allowedHosts);
    },
    configurePreviewServer(server) {
      install(
        server.httpServer,
        server.config.preview?.allowedHosts ??
          server.config.server.allowedHosts,
      );
    },
  };
}

export { deepgramVoiceProxy };
