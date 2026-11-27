/**
 * AP3-4 UX & safety tests: horizontal-only card swipe, independent .ap-card-copy scroll,
 * interactive compact LiveRadarCard, and EN/JA i18n parity.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifySwipe } from '../src/lib/autopilot/deck-core.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('AP3-4: classifySwipe with horizontalOnly ignores vertical scroll motion and accepts left/right', () => {
  const vertUp = classifySwipe(4, -120, 90, { horizontalOnly: true })
  assert.equal(vertUp.direction, null)
  assert.equal(vertUp.committed, false)

  const vertDown = classifySwipe(-5, 110, 90, { horizontalOnly: true })
  assert.equal(vertDown.direction, null)
  assert.equal(vertDown.committed, false)

  const horizRight = classifySwipe(98, 12, 90, { horizontalOnly: true })
  assert.equal(horizRight.direction, 'right')
  assert.equal(horizRight.committed, true)

  const horizLeft = classifySwipe(-95, -8, 90, { horizontalOnly: true })
  assert.equal(horizLeft.direction, 'left')
  assert.equal(horizLeft.committed, true)
})

test('AP3-4: AutopilotDeck excludes .ap-card-copy and locks swipe to horizontalOnly', () => {
  const deckSrc = read('apps/web/src/features/autopilot/AutopilotDeck.jsx')
  assert.match(deckSrc, /horizontalOnly:\s*true/)
  assert.match(deckSrc, /\.ap-card-copy/)

  const stageSrc = read('apps/web/src/features/autopilot/DeckCardStage.jsx')
  assert.match(stageSrc, /ap-card-copy/)
  assert.match(stageSrc, /ap-copy-scrollbar/)
  assert.match(stageSrc, /ap-copy-thumb/)
  assert.match(stageSrc, /ap-copy-more-btn/)
})

test('AP3-3/4 & Panoptes: LiveRadarCard renders 8 stations, interactive Context Eye, inspector, and Vibe gating without timers', () => {
  const radarSrc = read('apps/web/src/features/autopilot/LiveRadarCard.jsx')
  assert.match(radarSrc, /ap-radar-station-node/)
  assert.match(radarSrc, /ap-radar-station-hit/)
  assert.match(radarSrc, /ap-radar-eye/)
  assert.match(radarSrc, /ap-radar-inspector/)
  assert.match(radarSrc, /ap-radar-peek/)
  assert.doesNotMatch(radarSrc, /setInterval/)
  assert.doesNotMatch(radarSrc, /\bfetch\s*\(/)

  const radarCss = read('apps/web/src/styles/autopilot-radar.css')
  assert.match(radarCss, /html\[data-vibe='dopamine'\]\s+\.ap-radar-sweep/)
  assert.match(radarCss, /html\[data-vibe='serotonin'\]\s+\.ap-radar-sweep/)

  const cardsSrc = read('apps/web/src/features/autopilot/AutopilotCards.jsx')
  assert.doesNotMatch(cardsSrc, /ap-wipe-inline/)
  assert.match(cardsSrc, /ap-step-drawer/)
  assert.match(cardsSrc, /ap-nudge-badge/)

  assert.match(radarSrc, /ap-radar-nudge-pin/)
  assert.match(radarSrc, /ap-xray-diffbar/)
  assert.match(radarSrc, /ap-radar-workers-row/)
  assert.match(radarCss, /\.worker-w1/)
  assert.match(radarCss, /\.worker-w2/)
})

test('AP3-3/4 & Panoptes/X-Ray i18n keys exist in both en.json and ja.json', () => {
  const en = JSON.parse(read('apps/web/src/i18n/en.json'))
  const ja = JSON.parse(read('apps/web/src/i18n/ja.json'))
  for (const k of [
    'autopilot.radar.runTokens',
    'autopilot.radar.stageYou',
    'autopilot.radar.stageFiles',
    'autopilot.radar.stageShell',
    'autopilot.radar.stageWeb',
    'autopilot.radar.stageBrowser',
    'autopilot.radar.stageAgents',
    'autopilot.radar.stageMemory',
    'autopilot.radar.stageTools',
    'autopilot.radar.coreToggleHint',
    'autopilot.radar.browserPeekTitle',
    'autopilot.radar.errorTitle',
    'autopilot.radar.cmdIntentStyle',
    'autopilot.radar.cmdIntentTest',
    'autopilot.radar.xrayPass',
    'autopilot.radar.xrayFail',
    'autopilot.radar.xrayNudgeTitle',
    'autopilot.radar.parallelBadge',
    'autopilot.nudge.btn',
    'autopilot.nudge.queuedToast',
    'autopilot.live.reviewDesign',
    'autopilot.live.reviewBuild',
    'autopilot.live.elapsedAria',
    'autopilot.copy.more',
    'autopilot.copy.less',
  ]) {
    assert.ok(typeof en[k] === 'string' && en[k].length > 0, `Missing en.json key: ${k}`)
    assert.ok(typeof ja[k] === 'string' && ja[k].length > 0, `Missing ja.json key: ${k}`)
  }
  assert.equal(ja['autopilot.radar.runTokens'], 'トークン')
  assert.equal(en['autopilot.radar.runTokens'], 'Tokens')
})

test('AutopilotDeck axis-locks vertical scroll and CSS enables scrollable .ap-view with sticky action bar & elapsed pill', () => {
  const deckSrc = read('apps/web/src/features/autopilot/AutopilotDeck.jsx')
  assert.match(deckSrc, /g\.locked\s*=\s*'v'/)
  assert.match(deckSrc, /g\.locked\s*=\s*'h'/)

  const deckCss = read('apps/web/src/styles/autopilot-deck.css')
  assert.match(deckCss, /\.ap-view\s*\{[^}]*height:\s*100%[^}]*overflow-y:\s*auto/s)
  assert.match(deckCss, /\.ap-action-bar\s*\{[^}]*position:\s*sticky/s)

  const cardsSrc = read('apps/web/src/features/autopilot/AutopilotCards.jsx')
  assert.match(cardsSrc, /ap-elapsed-pill/)
  assert.doesNotMatch(cardsSrc, /ap-batch-pill/)
})
