import { GevRealtimeController } from './realtimeController.js';
import { DeepgramConnection } from './deepgramConnection.js';

/**
 * Adapt the voice controller to the common voice session. `provider` picks the
 * transport: OpenAI Realtime over WebRTC (default) or the Deepgram agent proxy,
 * which has no token meter, so its cost controls are hidden.
 */
export function createRealtimeSession({
  emit,
  runAction,
  provider = 'openai',
  createController = (options) => new GevRealtimeController(options),
  ...options
}) {
  const deepgram = provider === 'deepgram';
  const controller = createController({
    ...options,
    ...(deepgram
      ? { createConnection: (opts) => new DeepgramConnection(opts) }
      : {}),
    actionExecutor: runAction,
    onSessionEvent: emit,
  });
  return {
    controller,
    capabilities: { costControls: !deepgram, pushToTalk: true },
    start: (settings) => controller.start(settings),
    stop: (settings) => controller.stop(settings),
    sendText: (text) => controller.sendTextCommand(text),
    sendMapEvent: (event) => controller.notifyMapEvent(event),
    ignoreButtonClick: () => Boolean(controller.spaceKeyHeld),
    bindControls() {
      if (controller.ui.tierButton) {
        controller.tierHandler = () => controller.toggleVoiceTier();
        controller.ui.tierButton.addEventListener(
          'click',
          controller.tierHandler,
        );
      }
      controller.syncCostUi();
      controller.bindPushToTalkShortcut();
    },
  };
}
