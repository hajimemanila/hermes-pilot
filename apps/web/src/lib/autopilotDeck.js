/**
 * Autopilot v2 スワイプデッキ & 4 幕スタジオ投影の純関数群（再エクスポート専用バレル）。実装は `./autopilot/{deck-core,deck-flow,studio}.js`。
 * 1 選択肢 = 1 カード（A → 左スワイプで B → C → REMIX）、ライブ実況翻訳、成果物抽出。下の 27 名が公開契約（契約テストで固定）。
 */

export {
  AUTOPILOT_RECIPES,
  EDGE_DEAD_ZONE_PX,
  MAX_STYLE_GACHA,
  REMIX_CHIPS,
  REMIX_CHIP_WINDOW_MS,
  STYLE_GACHA_PRESETS,
  SWIPE_STAMPS,
  SWIPE_THRESHOLD_PX,
  UNDO_WINDOW_MS,
  classifySwipe,
  isInEdgeDeadZone,
  nextOptionIndex,
  resolveStoryTapZone,
} from './autopilot/deck-core.js'

export {
  buildAnswerPayload,
  buildDeckFromSheet,
  buildRemixPayload,
  createRemixPending,
  createUndoEntry,
  currentOptionCard,
  resolveHoldOutcome,
  resolveOptionSwipe,
  isUndoActive,
} from './autopilot/deck-flow.js'

export {
  extractDeliverable,
  isReachablePublicUrl,
  isSameOriginPreviewUrl,
  projectStudioStage,
  translateActivity,
} from './autopilot/studio.js'
