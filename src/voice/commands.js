import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createRealtimeSession } from './realtimeSession.js';

/** The server's voice provider, announced in a meta tag (server/providers/deepgram.js). */
export function configuredVoiceProvider(doc = globalThis.document) {
  const value = doc
    ?.querySelector?.('meta[name="gev-voice-provider"]')
    ?.getAttribute?.('content');
  return value === 'deepgram' ? 'deepgram' : 'openai';
}

/** Default composition; callers may supply another session adapter factory. */
export function createVoiceCommands(options) {
  const provider = configuredVoiceProvider();
  return bindVoiceCommands({
    createSession: (hooks) => createRealtimeSession({ ...hooks, provider }),
    ...options,
  });
}
