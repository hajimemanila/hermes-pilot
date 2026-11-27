/**
 * pane の公開契約（SPEC-COHERENCE-SWEEP-3 §3.2 / CSW3-1）。
 *
 * ChatPane / TasksPane を `features/chat/` と `features/tasks/` へ割っていく前に、
 * **外から見える形**（export 名・props キー・静的な className）をここで凍結する。
 * 分割で 1 つでも落ちたら、その場で赤くなる＝`App.jsx` とソースを読むテスト 3 本を
 * 無変更で通せる状態を機械で保つ。
 *
 * `import()` では判定しない: Node は `.jsx` を解決できない（`ERR_UNKNOWN_FILE_EXTENSION`）ので、
 * ソースから宣言を読む。判定したいのは「公開名の集合」なので同じ強さになる。
 *
 * className は**欠落のみ**を fail にする（追加は許す）。分割で要素が別ファイルへ移るのが目的で、
 * クラス名そのものは変えない約束だから。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')

/** 凍結する 2 つの pane。`props` は宣言順、比較時にソートする。 */
const PANES = {
  ChatPane: {
    file: 'apps/web/src/features/ChatPane.jsx',
    dir: 'apps/web/src/features/chat',
    props: [
      'notify',
      'chatReports',
      'reviewItems',
      'liveTurns',
      'active',
      'openRequest',
      'onConsumedOpen',
      'discussRequest',
      'onConsumedDiscuss',
    ],
    classes: [
      'action-bar',
      'attach-file',
      'attach-file-name',
      'attach-rail',
      'attach-x',
      'banner',
      'banner ro',
      'bubble',
      'bubble-files',
      'bubble-img',
      'bubble-imgs',
      'bubble-menu-btn',
      'bubble-menu-preview',
      'chat-body',
      'chat-head',
      'chat-live-card running',
      'chat-live-card warn',
      'chat-live-head',
      'chat-live-sub',
      'chat-live-title',
      'chat-older',
      'chat-report-banner',
      'chat-report-banner-text',
      'chat-report-btn',
      'chat-report-btn primary',
      'chat-scroll',
      'chat-split-detail',
      'chat-split-group',
      'chat-split-head',
      'chat-split-list',
      'chat-split-master',
      'chat-split-stack',
      'chat-title',
      'chips-scroll',
      'composer',
      'composer-ro',
      'dots',
      'drawer-btn-badge',
      'empty',
      'empty-recent',
      'empty-recent-head',
      'empty-recent-mark',
      'empty-recent-row',
      'empty-recent-title',
      'empty-recent-when',
      'file-chip',
      'file-size',
      'icon-btn',
      'icon-btn dc-icon',
      'list',
      'list-head',
      'list-item',
      'msg notice',
      'msg report',
      'msg-tools',
      'nav-dot done',
      'pick-item',
      'pick-list',
      'pick-main',
      'pick-title',
      'pill',
      'plus',
      'prof-chip',
      'prof-chip on',
      'prof-chip repo-chip',
      'report-body',
      'report-link',
      'row',
      'row-main',
      'row-sub',
      'row-title',
      'sec',
      'send',
      'send stop',
      'snippet-chip add',
      'snippet-chip-add-glyph',
      'thinking thinking-card',
      'usage',
      'working-dot',
      'working-head',
      'working-meta',
      'working-shimmer',
    ],
  },
  TasksPane: {
    file: 'apps/web/src/features/TasksPane.jsx',
    dir: 'apps/web/src/features/tasks',
    props: [
      'overview',
      'refresh',
      'notify',
      'initialInbox',
      'pendingInboxOpen',
      'onConsumedPendingInboxOpen',
      'focusBoard',
      'onConsumedFocusBoard',
      'taskToolRequest',
      'onConsumedTaskTool',
      'active',
    ],
    classes: [
      'ap-swipe-strip',
      'banner paused',
      'btn',
      'btn history-open-task',
      'btn primary',
      'btn spec-md-open',
      'empty',
      'git-badge',
      'git-dc',
      'git-dirty',
      'git-sha',
      'git-subject',
      'history-body',
      'history-head',
      'history-label',
      'history-objective',
      'history-result',
      'history-section',
      'history-state',
      'history-state-in',
      'history-sub-details',
      'history-summary',
      'history-task',
      'history-title',
      'history-when',
      'hold-grid',
      'inbox-bar',
      'inbox-bar-go',
      'kill-open',
      'kill-section',
      'kill-section-sub',
      'kill-section-title',
      'link',
      'link spec-batch-toggle',
      'list',
      'list-head',
      'list-head spec-children-head',
      'live-dot',
      'organize-bar',
      'organize-count',
      'organize-head',
      'pick-item board-now',
      'pick-item history-row',
      'pick-list',
      'pick-main',
      'pick-meta',
      'pick-sub',
      'pick-title',
      'pipeline-summary-actions',
      'pipeline-summary-body',
      'pipeline-summary-head',
      'pipeline-summary-icon',
      'pipeline-summary-sub',
      'pipeline-summary-title',
      'pipeline-summary-when',
      'report-card-btn',
      'report-card-btn primary',
      'row-main',
      'row-sub',
      'row-title',
      'seed-entry',
      'snippet-chip trigger',
      'spec-archive-row',
      'spec-bar-main',
      'spec-bar-n',
      'spec-bar-name',
      'spec-bar-title',
      'spec-batch-detail',
      'spec-check',
      'spec-check organize-check',
      'spec-children-section',
      'spec-md-row',
      'spec-taken',
      'stat',
      'stat-k',
      'stat-v',
      'strip',
      'warn-card',
    ],
  },
}

/** リポジトリ相対パス（ファイルなら 1 本、ディレクトリなら再帰）のソース。 */
function sourcesOf(rel) {
  const abs = path.join(ROOT, rel)
  if (fs.statSync(abs).isFile()) return [fs.readFileSync(abs, 'utf8')]
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .flatMap((entry) => sourcesOf(path.posix.join(rel, entry.name)))
}

/** pane 本体と、これから切り出し先になるディレクトリのソースをまとめて読む。 */
function paneSources(pane) {
  return [...sourcesOf(pane.file), ...sourcesOf(pane.dir)]
}

/** `export` 宣言から公開名を取り出す。 */
function exportedNames(source) {
  const out = []
  for (const m of source.matchAll(/^[ \t]*export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    out.push(m[1])
  }
  for (const m of source.matchAll(/^[ \t]*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const one = /^\s*([A-Za-z_$][\w$]*)/.exec(part)
      if (one) out.push(one[1])
    }
  }
  return out.sort()
}

/**
 * `export function NAME({ ... })` の分割代入から props キーを取る。
 *
 * 既定値は `= null` / `= []` / `= true` のような単純なものだけを想定する
 * （カンマを含む既定値が入ったら、ここで気づける形で落ちる）。
 */
function propKeys(source, name) {
  const at = source.indexOf(`export function ${name}(`)
  assert.ok(at >= 0, `${name} must stay an exported function declaration`)
  const open = source.indexOf('(', at)
  let depth = 0
  let close = open
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  const body = source.slice(open + 1, close).trim()
  assert.ok(body.startsWith('{') && body.endsWith('}'), `${name} must destructure its props`)
  return body
    .slice(1, -1)
    .split(',')
    .map((part) => part.split('=')[0].split(':')[0].trim().replace(/^\.\.\./, ''))
    .filter(Boolean)
    .sort()
}

/** `className="..."` の静的文字列（テンプレート式は対象外）。 */
function staticClasses(sources) {
  const out = new Set()
  for (const source of sources) {
    for (const m of source.matchAll(/className="([^"]*)"/g)) {
      const value = m[1].trim()
      if (value) out.add(value)
    }
  }
  return out
}

for (const [name, pane] of Object.entries(PANES)) {
  test(`${name}: 公開 export 名は 1 つだけ`, () => {
    const source = fs.readFileSync(path.join(ROOT, pane.file), 'utf8')
    assert.deepEqual(exportedNames(source), [name])
  })

  test(`${name}: props キー集合が凍結どおり`, () => {
    const source = fs.readFileSync(path.join(ROOT, pane.file), 'utf8')
    assert.deepEqual(propKeys(source, name), [...pane.props].sort())
  })

  test(`${name}: 静的な className が 1 つも消えていない`, () => {
    const current = staticClasses(paneSources(pane))
    const missing = pane.classes.filter((className) => !current.has(className))
    assert.deepEqual(missing, [], `${name} lost className(s): ${missing.join(' / ')}`)
  })
}
