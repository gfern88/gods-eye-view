/**
 * Deepgram Voice Agent Settings, built server-side so a browser can never
 * rewrite the prompt, tools or model. Pure: reads only the env object passed in.
 * Field names follow https://developers.deepgram.com/docs/voice-agent-settings.
 */
import { realtimeInstructions } from '../openai/instructions.js';

export const DEEPGRAM_AGENT_URL = 'wss://agent.deepgram.com/v1/agent/converse';
export const DEEPGRAM_INPUT_SAMPLE_RATE = 16000;
export const DEEPGRAM_OUTPUT_SAMPLE_RATE = 24000;
/** Deepgram's cap on think.prompt for Deepgram-managed LLMs. */
export const DEEPGRAM_MANAGED_PROMPT_LIMIT = 25000;

const THINK_DEFAULTS = Object.freeze({
  open_ai: 'gpt-4.1-mini',
  anthropic: 'claude-haiku-4-5',
});

// Own-key endpoints per think type: the vendor's base URL, the request path
// Deepgram calls, and the auth header. DEEPGRAM_THINK_URL swaps the base for
// any compatible service (e.g. an OpenAI-compatible gateway).
const OWN_KEY_ENDPOINTS = Object.freeze({
  open_ai: {
    base: 'https://api.openai.com/v1',
    path: '/chat/completions',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
  },
  anthropic: {
    base: 'https://api.anthropic.com/v1',
    path: '/messages',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
});

/**
 * The think endpoint for an own key and/or custom URL. A URL given as a base
 * (`https://api.example.com/v1`) gets the type's request path appended.
 */
function thinkEndpoint(provider, env) {
  const spec = OWN_KEY_ENDPOINTS[provider];
  const key = clean(env.DEEPGRAM_THINK_API_KEY);
  const url = clean(env.DEEPGRAM_THINK_URL) || spec.base;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DEEPGRAM_THINK_URL is not a valid URL');
  }
  // Deepgram calls custom think endpoints over https only.
  if (parsed.protocol !== 'https:') {
    throw new Error('DEEPGRAM_THINK_URL must use https');
  }
  // Work on the path, so a query string (e.g. ?api-version=) is kept intact.
  const path = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = path.endsWith(spec.path) ? path : path + spec.path;
  return { url: parsed.href, headers: key ? spec.headers(key) : {} };
}

// Words the default speech model mishears in this app.
const KEYTERMS = Object.freeze([
  'ADS-B',
  'AIS',
  'FLIR',
  'NVG',
  'CCTV',
  'Cesium',
  'callsign',
  'squawk',
  'Starlink',
]);

const DEEPGRAM_PROMPT_ADDENDUM = [
  'VOICE PIPELINE NOTES: you hear the user through speech-to-text and reply through text-to-speech.',
  'You never receive screenshots, pointer crops, pointer_context or map_annotation_outline items in this session: do not refer to them, and do not use screenX/screenY.',
  'Keep every reply short and speakable: no markdown, lists, emoji or URLs.',
].join('\n');

const clean = (value) => String(value ?? '').trim();

/**
 * Which LLM thinks for the agent.
 * @param {Record<string,string|undefined>} env
 * @returns {{provider: 'open_ai'|'anthropic', model: string, ownKey: boolean}}
 */
export function resolveThink(env = {}) {
  const raw = clean(env.DEEPGRAM_THINK_PROVIDER).toLowerCase();
  const provider =
    raw === 'anthropic' ? 'anthropic' : raw === 'openai' ? 'open_ai' : raw;
  if (provider && !THINK_DEFAULTS[provider]) {
    throw new Error(
      `DEEPGRAM_THINK_PROVIDER must be open_ai or anthropic, not "${raw}"`,
    );
  }
  const chosen = provider || 'open_ai';
  return {
    provider: chosen,
    model: clean(env.DEEPGRAM_THINK_MODEL) || THINK_DEFAULTS[chosen],
    ownKey: Boolean(
      clean(env.DEEPGRAM_THINK_API_KEY) || clean(env.DEEPGRAM_THINK_URL),
    ),
  };
}

/**
 * Map the OpenAI Realtime tool list to Deepgram client-side functions.
 * @param {Array<{name:string, description?:string, parameters?:object}>} tools
 */
export function deepgramFunctions(tools = []) {
  return tools.map(({ name, description, parameters }) => ({
    name,
    description: description || name,
    parameters: parameters || { type: 'object', properties: {} },
  }));
}

const REASONING_MODES = new Set(['none', 'minimal', 'low', 'medium', 'high']);

/**
 * DEEPGRAM_THINK_REASONING: how long a reasoning model may think before it
 * speaks (Deepgram's open_ai `reasoning_mode`). Voice needs `minimal` for
 * reasoning models, which otherwise think past Deepgram's think timeout.
 */
function reasoningMode(provider, env) {
  const mode = clean(env.DEEPGRAM_THINK_REASONING).toLowerCase();
  if (!mode) return {};
  if (!REASONING_MODES.has(mode)) {
    throw new Error(
      `DEEPGRAM_THINK_REASONING must be one of ${[...REASONING_MODES].join(', ')}`,
    );
  }
  // Deepgram documents reasoning_mode for the open_ai type only.
  return provider === 'open_ai' ? { reasoning_mode: mode } : {};
}

/**
 * The complete Settings message.
 * @param {{env?: Record<string,string|undefined>, tools?: object[], annotationGuidance?: string}} options
 */
export function buildDeepgramSettings({
  env = {},
  tools = [],
  annotationGuidance,
} = {}) {
  const think = resolveThink(env);
  const prompt = `${realtimeInstructions(annotationGuidance)}\n${DEEPGRAM_PROMPT_ADDENDUM}`;
  const thinkConfig = {
    provider: {
      type: think.provider,
      version: 'v1',
      model: think.model,
      ...reasoningMode(think.provider, env),
    },
    prompt,
    functions: deepgramFunctions(tools),
  };
  if (think.ownKey) thinkConfig.endpoint = thinkEndpoint(think.provider, env);
  return {
    type: 'Settings',
    tags: ['gods-eye-view'],
    flags: { history: false },
    audio: {
      input: { encoding: 'linear16', sample_rate: DEEPGRAM_INPUT_SAMPLE_RATE },
      output: {
        encoding: 'linear16',
        sample_rate: DEEPGRAM_OUTPUT_SAMPLE_RATE,
        container: 'none',
      },
    },
    agent: {
      listen: {
        provider: {
          type: 'deepgram',
          version: 'v1',
          model: clean(env.DEEPGRAM_LISTEN_MODEL) || 'nova-3',
          language: clean(env.DEEPGRAM_LANGUAGE) || 'en-US',
          smart_format: true,
          keyterms: [...KEYTERMS],
        },
      },
      think: thinkConfig,
      speak: {
        provider: {
          type: 'deepgram',
          version: 'v1',
          model: clean(env.DEEPGRAM_SPEAK_MODEL) || 'aura-2-thalia-en',
        },
      },
    },
  };
}

/**
 * Voice provider for this server: VOICE_PROVIDER wins (Deepgram only with its
 * key, so a forced but unkeyed Deepgram falls back instead of a dead mic),
 * else Deepgram when its key is set, else OpenAI.
 * @param {Record<string,string|undefined>} env
 * @returns {'deepgram'|'openai'}
 */
export function resolveVoiceProvider(env = {}) {
  const keyed = Boolean(clean(env.DEEPGRAM_API_KEY));
  const forced = clean(env.VOICE_PROVIDER).toLowerCase();
  if (forced === 'openai') return 'openai';
  return keyed ? 'deepgram' : 'openai';
}
