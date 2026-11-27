/**
 * タブレット横持ちのチャット 2 カラム（SPEC-ver-0-2-1 §2.3 / Batch ver-0-2-1-5）の検証。
 *
 * 見るのは「壊れたら必ず落ちる構造」だけ:
 *
 * - 左カラム下端へ移す 4 グループの名前と順番は `lib/chatSplit.js` が正本
 * - JSX（`features/ChatPane.jsx`）は `wide` のときだけ 2 カラムにし、
 *   **右カラムには最小ヘッダとタイムラインしか置かない**（Q1=A: バナー・チップ・
 *   定型チップ帯・入力欄は 1 つも出さない）
 * - 1 ペイン（820px 未満）の並びは現行のまま（DOM 順も変えない）
 * - CSS は既存の `@media (min-width: 820px)` の中にだけ書き、`@media` を増やさない
 *   （増やしていないことは `layoutBreakpoints.test.js` が集合一致で見る）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CHAT_SPLIT_STACK, CHAT_SPLIT_DETAIL, chatGroupMarks, chatSplitChrome } from '../src/lib/chatSplit.js'
import { MASTER_W, SPLIT_WIDE_MIN } from '../src/lib/layout.js'
import { readStyles } from './helpers/styles.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const jsx = fs.readFileSync(path.join(ROOT, 'src/features/ChatPane.jsx'), 'utf8')
// タイムラインの中身（`.chat-body` と「↓ 最新へ」）は CSW3-3 で切り出した先にある
const timelineSrc = fs.readFileSync(path.join(ROOT, 'src/features/chat/ChatTimeline.jsx'), 'utf8')
const css = readStyles().replace(/\/\*[\s\S]*?\*\//g, '')
const splitSrc = fs.readFileSync(path.join(ROOT, 'src/lib/chatSplit.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** `@media <query> { … }` の中身（対応する閉じ括弧まで）。 */
function mediaBlock(source, query) {
  const at = source.indexOf(`@media ${query}`)
  assert.notEqual(at, -1, `@media ${query} が無い`)
  let depth = 0
  let start = -1
  for (let i = at; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1
      if (depth === 1) start = i + 1
    } else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i)
    }
  }
  throw new Error(`@media ${query} が閉じていない`)
}

/**
 * `const <name> = ( … )` のブロックを切り出す（同じ深さの閉じ括弧まで）。
 * @param {string} source ChatPane.jsx の全文
 * @param {string} name 変数名
 * @returns {string}
 */
function constBlock(source, name) {
  const at = source.indexOf(`const ${name} = (`)
  assert.notEqual(at, -1, `const ${name} = ( が無い`)
  const end = source.indexOf('\n  )', at)
  assert.notEqual(end, -1, `const ${name} の閉じ括弧が無い`)
  return source.slice(at, end)
}

const wideCss = mediaBlock(css, `(min-width: ${SPLIT_WIDE_MIN}px)`)
const narrowCss = mediaBlock(css, `(min-width: 680px) and (max-width: 819.98px)`)

test('chatSplitChrome: 左の下端スタックは バナー → チップ → 定型帯 → 入力欄 の 4 グループ', () => {
  assert.deepEqual(chatSplitChrome(), ['banners', 'chips', 'snippets', 'composer'])
  assert.deepEqual(CHAT_SPLIT_STACK, ['banners', 'chips', 'snippets', 'composer'])
  // 呼び出し側が壊さないようコピーを返す
  const first = chatSplitChrome()
  first.push('x')
  assert.deepEqual(chatSplitChrome(), ['banners', 'chips', 'snippets', 'composer'])
})

test('chatSplit: 右カラムは最小ヘッダとタイムラインだけ', () => {
  assert.deepEqual(CHAT_SPLIT_DETAIL, ['head', 'timeline'])
})

test('chatGroupMarks: 4 グループすべてに DOM の印があり、未知のグループは空', () => {
  for (const group of CHAT_SPLIT_STACK) {
    assert.ok(chatGroupMarks(group).length > 0, `${group} の印が空`)
  }
  assert.deepEqual(chatGroupMarks('unknown'), [])
  // 入力欄のグループは読み取り専用の composer-ro も同じ枠として持つ
  assert.ok(chatGroupMarks('composer').includes('composer'))
  assert.ok(chatGroupMarks('composer').includes('composer-ro'))
})

test('chatSplit.js: 境界の数値をここへ書き写していない（正本は lib/layout.js）', () => {
  assert.ok(!/@media/.test(splitSrc), 'chatSplit.js が @media を持っている')
  assert.ok(!/\b820\b/.test(splitSrc), 'chatSplit.js に 820 が手書きされている')
})

test('CSS: 2 カラムの器は 820px の既存ブロックの中だけにある', () => {
  for (const cls of ['.pane.chat.split-layout', '.chat-split-master', '.chat-split-detail', '.chat-split-stack']) {
    assert.ok(wideCss.includes(cls), `@media (min-width: 820px) に ${cls} が無い`)
    assert.ok(!narrowCss.includes(cls), `${cls} が 680–819px のブロックにも書かれている（1 ペインのままにする）`)
  }
  // 左は固定幅・右は伸ばす（`.pane.chat` は元々 flex なので向きだけ変える）
  assert.match(wideCss, /\.pane\.chat\.split-layout\s*\{[^}]*flex-direction:\s*row/)
  assert.match(wideCss, /\.chat-split-master\s*\{[^}]*flex:\s*0 0 var\(--split-master-w/)
  assert.match(wideCss, /\.chat-split-detail\s*\{[^}]*flex:\s*1 1 auto/)
  // 一覧とスタックは別々にスクロールする（入力欄が本文に押し出されない）
  assert.match(wideCss, /\.chat-split-list\s*\{[^}]*overflow-y:\s*auto/)
  assert.match(wideCss, /\.chat-split-stack\s*\{[^}]*max-height:\s*62%/)
})

test('CSS: チャットの左幅は layout.js の MASTER_W.wide.chat と一致する', () => {
  assert.equal(MASTER_W.wide.chat, 380)
  assert.match(css, new RegExp(`\\.split-layout\\.chat\\s*\\{\\s*--split-master-w:\\s*${MASTER_W.wide.chat}px`))
})

test('JSX: wide のときだけ 2 カラムになる', () => {
  assert.match(jsx, /const \{ wide \} = useSplitLayout\(\)/)
  assert.match(jsx, /const splitChat = wide\b/)
  assert.ok(
    jsx.includes("className={splitChat ? 'pane chat split-layout' : 'pane chat'}"),
    'ルートのクラスが splitChat で切り替わっていない',
  )
  // 820px の数値を ChatPane に書き写していない（境界は lib/layout.js が正本）
  assert.ok(!/matchMedia|innerWidth/.test(jsx), 'ChatPane が幅を自前で測っている（useSplitLayout を使う）')
})

test('JSX: 右カラムは最小ヘッダ＋タイムラインだけで、バナー・チップ・定型帯・入力欄を置かない', () => {
  // 右カラムの子は 2 つのノード参照だけ（ここに足したら即座に落ちる）
  assert.match(
    jsx,
    /<div className="chat-split-detail">\s*\{minimalHeadNode\}\s*\{timelineNode\}\s*<\/div>/,
    '右カラムに最小ヘッダとタイムライン以外が入っている',
  )

  const head = constBlock(jsx, 'minimalHeadNode')
  // タイムラインは `ChatTimeline`（`features/chat/ChatTimeline.jsx`）の中身まで見る
  const timeline = `${constBlock(jsx, 'timelineNode')}\n${timelineSrc.slice(timelineSrc.indexOf('export function ChatTimeline('))}`

  // 右カラムの中身に、左へ移す 4 グループの印が 1 つも無い
  const marks = CHAT_SPLIT_STACK.flatMap((g) => chatGroupMarks(g))
  for (const mark of marks) {
    const re = new RegExp(`className=(?:"|\\{\`)${mark}[\\s"'\`]`)
    assert.ok(!re.test(head), `右カラムのヘッダに .${mark} が出ている`)
    assert.ok(!re.test(timeline), `右カラムのタイムラインに .${mark} が出ている`)
  }
  // タイムラインは従来の .chat-body（ここが右の縦を全部使う）
  assert.ok(timeline.includes('className="chat-body"'), 'タイムラインが .chat-body を持っていない')
  assert.ok(!timeline.includes('className="chat-head"'), 'タイムラインが .chat-head を持っている')
})

test('JSX: 左カラムは 一覧＋下端スタック（4 グループを chatSplitChrome() の順で積む）', () => {
  assert.match(
    jsx,
    /<div className="chat-split-list">\s*<ChatSessionList \{\.\.\.sessionListProps\} \/>\s*<\/div>/,
    '左カラムの一覧が ChatSessionList（材料は sessionListProps）になっていない',
  )
  assert.match(jsx, /<div className="chat-split-stack">/)
  assert.match(jsx, /\{chatSplitChrome\(\)\.map\(\(group\) => \(/)

  const stack = jsx.slice(jsx.indexOf('const splitStackNodes = {'))
  const stackBody = stack.slice(0, stack.indexOf('\n  }\n'))
  for (const node of ['bannerNode', 'chipsNode', 'actionBarNode', 'composerNode']) {
    assert.ok(stackBody.includes(`{${node}}`) || stackBody.includes(`: ${node},`), `スタックに ${node} が無い`)
  }
  // 入力欄は読み取り専用の composer-ro も同じグループに入る
  assert.ok(stackBody.includes('composerNode'))
})

test('JSX: セッション一覧は 1 つだけ定義し、ドロワーと左カラムで共用する', () => {
  // 一覧の定義は `features/chat/ChatParts.jsx`、ドロワーの器は
  // `features/chat/ChatDrawer.jsx` へ切り出し済み（ChatPane の肥大化解消）。
  // 「定義は 1 つだけ」は 3 ファイルを合わせて数える。
  const parts = fs.readFileSync(path.join(ROOT, 'src/features/chat/ChatParts.jsx'), 'utf8')
  const drawer = fs.readFileSync(path.join(ROOT, 'src/features/chat/ChatDrawer.jsx'), 'utf8')
  const defs = `${jsx}\n${parts}\n${drawer}`.match(/function ChatSessionList\(/g) ?? []
  assert.equal(defs.length, 1, 'ChatSessionList が 1 つではない（中身を書き分けている）')
  // ドロワーは Sheet のラッパーだけ（境界③ `({ open, onClose, title, listProps })`）
  assert.match(drawer, /<Sheet title=\{title\} onClose=\{onClose\}>/, 'ドロワーが Sheet で包んでいない')
  assert.match(drawer, /<ChatSessionList \{\.\.\.listProps\} \/>/, 'ドロワーが listProps を一覧へ渡していない')
  // 一覧の実体は 1 ペインのドロワーと 2 カラムの左で同じものを使う（材料は親が 1 回だけ組む）
  const listUses = jsx.match(/<ChatSessionList \{\.\.\.sessionListProps\} \/>/g) ?? []
  assert.equal(listUses.length, 1, `左カラムの一覧が ${listUses.length} 箇所（1 箇所のはず）`)
  assert.match(
    jsx,
    /<ChatDrawer\s+open=\{drawer\}\s+onClose=\{\(\) => setDrawer\(false\)\}\s+title=\{t\('chat\.drawerTitle'\)\}\s+listProps=\{sessionListProps\}\s+\/>/,
    'ドロワー（ChatDrawer）へ一覧の材料が渡っていない',
  )
})

test('JSX: 1 ペインの並びは現行のまま（DOM 順を変えない）', () => {
  const one = /\) : \(\s*<>([\s\S]*?)<\/>/.exec(jsx)
  assert.ok(one, '1 ペインの分岐が見つからない')
  const order = [...one[1].matchAll(/\{(\w+Node)\}/g)].map((m) => m[1])
  assert.deepEqual(order, [
    'chatHeadNode',
    'bannerNode',
    'timelineNode',
    'attachNode',
    'jobBarNode',
    'specBannerNode',
    'actionBarNode',
    'composerNode',
  ])
  // ヘッダは 1 ペインでだけ出す（2 カラムでは一覧が左カラムにある）
  const split = /splitChat \? \(\s*<>([\s\S]*?)<\/>\s*\) : \(/.exec(jsx)
  assert.ok(split, '2 カラムの分岐が見つからない')
  assert.ok(!split[1].includes('{chatHeadNode}'), '2 カラムでも 1 ペインのヘッダを出している')
})
