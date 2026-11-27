/**
 * Autopilot v2 デッキの定数・データ・ジェスチャ判定（純関数）。
 * 旧 `lib/autopilotDeck.js` の :6-128 を移動したもの。公開契約は `lib/autopilotDeck.js`（バレル）が固定する。
 */

export const EDGE_DEAD_ZONE_PX = 24
export const SWIPE_THRESHOLD_PX = 90
export const UNDO_WINDOW_MS = 3000
export const REMIX_CHIP_WINDOW_MS = 2000
export const MAX_STYLE_GACHA = 3

export const STYLE_GACHA_PRESETS = [
  { id: 'minimal', icon: '◻', labelKey: 'autopilot.gacha.minimal' },
  { id: 'neon', icon: '⚡', labelKey: 'autopilot.gacha.neon' },
  { id: 'retro', icon: '📼', labelKey: 'autopilot.gacha.retro' },
  { id: 'editorial', icon: '📰', labelKey: 'autopilot.gacha.editorial' },
  { id: 'bento', icon: '🍱', labelKey: 'autopilot.gacha.bento' },
]

/** Instagram ストーリー風フリック比較のタップ領域判定（左45%: 前案 / 右45%: 次案）。 */
export function resolveStoryTapZone(clientX, rect) {
  const x = Number(clientX)
  const left = Number(rect?.left)
  const width = Number(rect?.width)
  if (!Number.isFinite(x) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0) {
    return 'center'
  }
  const ratio = (x - left) / width
  if (ratio <= 0.45) return 'prev'
  if (ratio >= 0.55) return 'next'
  return 'center'
}

/** 選択肢添字の循環移動（`0 .. totalCount - 1`）。 */
export function nextOptionIndex(currentIdx, totalCount, delta = 1) {
  const total = Number(totalCount) || 0
  if (total <= 1) return 0
  const cur = (((Number(currentIdx) || 0) % total) + total) % total
  const step = Number(delta) || 0
  return (((cur + step) % total) + total) % total
}

export const SWIPE_STAMPS = {
  right: 'GO',
  left: 'NEXT',
  up: 'ANNOTATE',
  down: 'HOLD',
}

export const REMIX_CHIPS = [
  { id: 'theme', icon: '🎨', labelKey: 'autopilot.remix.theme' },
  { id: 'simpler', icon: '📐', labelKey: 'autopilot.remix.simpler' },
  { id: 'denser', icon: '📊', labelKey: 'autopilot.remix.denser' },
  { id: 'note', icon: '💬', labelKey: 'autopilot.remix.note' },
]

/** 第1幕: ライト層向けのビジュアル・スターターカード（i18n キー参照、日本語直書き禁止）。 */
export const AUTOPILOT_RECIPES = [
  {
    id: 'timer',
    icon: '⏱',
    accent: 'cyan',
    titleKey: 'autopilot.recipe.timerTitle',
    subKey: 'autopilot.recipe.timerSub',
    seedKey: 'autopilot.recipe.timerSeed',
  },
  {
    id: 'habit',
    icon: '✅',
    accent: 'emerald',
    titleKey: 'autopilot.recipe.habitTitle',
    subKey: 'autopilot.recipe.habitSub',
    seedKey: 'autopilot.recipe.habitSeed',
  },
  {
    id: 'polish',
    icon: '🎨',
    accent: 'amber',
    titleKey: 'autopilot.recipe.polishTitle',
    subKey: 'autopilot.recipe.polishSub',
    seedKey: 'autopilot.recipe.polishSeed',
  },
  {
    id: 'tracker',
    icon: '📊',
    accent: 'violet',
    titleKey: 'autopilot.recipe.trackerTitle',
    subKey: 'autopilot.recipe.trackerSub',
    seedKey: 'autopilot.recipe.trackerSeed',
  },
]

export function isInEdgeDeadZone(startX, viewportWidth, edgePx = EDGE_DEAD_ZONE_PX) {
  const x = Number(startX)
  const w = Number(viewportWidth)
  if (!Number.isFinite(x)) return false
  if (x <= edgePx) return true
  if (Number.isFinite(w) && w > 0 && x >= w - edgePx) return true
  return false
}

export function classifySwipe(dx, dy, thresholdPx = SWIPE_THRESHOLD_PX, opts = {}) {
  const x = Number(dx) || 0
  const y = Number(dy) || 0
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  if (ax < 12 && ay < 12) {
    return { direction: null, stamp: null, progress: 0, committed: false }
  }
  let direction = null
  let dominant = 0
  if (opts?.horizontalOnly) {
    if (ax >= 12 && ax >= ay * 1.15) {
      direction = x > 0 ? 'right' : 'left'
      dominant = ax
    } else {
      return { direction: null, stamp: null, progress: 0, committed: false }
    }
  } else if (ax >= ay * 1.1) {
    direction = x > 0 ? 'right' : 'left'
    dominant = ax
  } else if (ay >= ax * 1.1) {
    direction = y < 0 ? 'up' : 'down'
    dominant = ay
  } else {
    return { direction: null, stamp: null, progress: 0, committed: false }
  }
  const progress = Math.min(1, dominant / Math.max(1, thresholdPx))
  return {
    direction,
    stamp: SWIPE_STAMPS[direction] || null,
    progress,
    committed: dominant >= thresholdPx,
  }
}
