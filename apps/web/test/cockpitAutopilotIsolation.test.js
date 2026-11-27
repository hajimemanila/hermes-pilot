/**
 * Regression guards ensuring Autopilot UI elements remain isolated from
 * Cockpit headers (ReviewPane `.ak-head-actions`, TasksPane `.list-head`)
 * and 390px topbar labels never wrap mid-word.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('AutopilotSwipeLink is NOT nested inside .ak-head-actions or .list-head', () => {
  const reviewSrc = read('apps/web/src/features/ReviewPane.jsx')
  const akHeadActionsBlock = /<span className="ak-head-actions">[\s\S]*?<\/span>/.exec(reviewSrc)
  assert.ok(akHeadActionsBlock, 'ak-head-actions block must exist in ReviewPane.jsx')
  assert.doesNotMatch(
    akHeadActionsBlock[0],
    /AutopilotSwipeLink/,
    'AutopilotSwipeLink must stay outside .ak-head-actions',
  )
  assert.match(reviewSrc, /<div className="ap-swipe-strip">\s*<AutopilotSwipeLink/)

  const tasksSrc = read('apps/web/src/features/TasksPane.jsx')
  const listHeadBlock = /<div className="list-head">[\s\S]*?<\/div>/.exec(tasksSrc)
  assert.ok(listHeadBlock, 'list-head block must exist in TasksPane.jsx')
  assert.doesNotMatch(
    listHeadBlock[0],
    /AutopilotSwipeLink/,
    'AutopilotSwipeLink must stay outside .list-head',
  )
  assert.match(tasksSrc, /<div className="ap-swipe-strip">\s*<AutopilotSwipeLink/)
})

test('Cockpit headers and topbar CSS prevent wrapping and crushing on 390px screens', () => {
  const autopilotCss = read('apps/web/src/styles/autopilot.css')
  assert.match(autopilotCss, /\.ap-lens-btn\s*\{[^}]*white-space:\s*nowrap/)
  assert.match(autopilotCss, /\.ap-swipe-link\s*\{[^}]*white-space:\s*nowrap/)

  const tokensCss = read('apps/web/src/styles/tokens.css')
  assert.match(tokensCss, /\.brand\s*\{[^}]*white-space:\s*nowrap/)

  const reviewCss = read('apps/web/src/styles/review.css')
  assert.match(reviewCss, /\.ak-head\s*\{[^}]*flex-wrap:\s*wrap/)
  assert.match(reviewCss, /\.ak-title\s*\{[^}]*white-space:\s*nowrap/)

  const listsCss = read('apps/web/src/styles/lists.css')
  assert.match(listsCss, /\.list-head\s*\{[^}]*flex-wrap:\s*wrap/)
})
