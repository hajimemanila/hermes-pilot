import test from 'node:test'
import assert from 'node:assert/strict'
import { answerRows, capturedLabel, DONE_LIMIT, doneHint, groupItems, isWaiting, navBadgeState, nextWaiting, pendingCount, repoLabel, runningCount, thumbCaption, unseenNotices, waitingCount } from '../src/lib/akapenView.js'

/** 赤ペン待ち（blocked + label）。 */
const waitingItem = (id) => ({ id, status: 'blocked', akapen: { label: 'akapen-view-01', round: 1 } })
/** 進行中（回答できない）。 */
const activeItem = (id, status) => ({ id, status, akapen: { label: 'x' } })
/** 完了。 */
const doneItem = (id) => ({ id, status: 'done', akapen: { label: 'x' } })

test('isWaiting は blocked かつ label 付きだけを赤ペン待ちとする', () => {
  assert.equal(isWaiting(waitingItem('t1')), true)
  assert.equal(isWaiting({ id: 't2', status: 'blocked', akapen: {} }), false, 'label 無しは待ちではない')
  assert.equal(isWaiting({ id: 't3', status: 'ready', akapen: { label: 'x' } }), false, 'ready は待ちではない')
  assert.equal(isWaiting({ id: 't4', status: 'review', akapen: { label: 'x' } }), false, 'review は回答を受けない')
  assert.equal(isWaiting(null), false)
})

test('groupItems: 判断待ち / 進行中 / 完了 に分かれ、完了は直近 8 件だけ（総数は別に持つ）', () => {
  const items = [
    waitingItem('w1'),
    waitingItem('w2'),
    activeItem('a1', 'ready'),
    activeItem('a2', 'running'),
    { id: 'a3', status: 'blocked', akapen: { label: null } },
    activeItem('r1', 'review'),
    ...Array.from({ length: 10 }, (_, i) => doneItem(`d${i}`)),
  ]
  const g = groupItems(items)

  assert.deepEqual(g.waiting.map((i) => i.id), ['w1', 'w2'])
  assert.deepEqual(g.active.map((i) => i.id), ['a1', 'a2', 'a3', 'r1'])
  assert.equal(g.done.length, DONE_LIMIT, '完了タブは直近 8 件まで')
  assert.equal(g.doneTotal, 10, '総数は偽らない（チップに件数を出さない根拠）')
  assert.deepEqual(g.done.map((i) => i.id), ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'])
})

test('groupItems は空・壊れた入力を落とさない', () => {
  assert.deepEqual(groupItems(undefined), { waiting: [], active: [], done: [], doneTotal: 0 })
  assert.deepEqual(groupItems([null, undefined]).waiting, [])
})

test('nextWaiting: 送信後は次を返し、最後の 1 件では null（閉じる）', () => {
  const afterFirst = [activeItem('w1', 'ready'), waitingItem('w2')]
  assert.equal(nextWaiting(afterFirst, 'w1')?.id, 'w2')

  const afterLast = [activeItem('w1', 'ready')]
  assert.equal(nextWaiting(afterLast, 'w1'), null)

  // 取得が古くて回答済みがまだ blocked のままでも、自分自身は開き直さない
  assert.equal(nextWaiting([waitingItem('w1'), waitingItem('w2')], 'w1')?.id, 'w2')
  assert.equal(nextWaiting([waitingItem('w1')], 'w1'), null)
})

test('doneHint は「直近 8 件」しか言わない（件数を偽らない）', () => {
  assert.equal(doneHint(0), '完了はまだありません')
  assert.equal(doneHint(3), '直近 3 件')
  assert.equal(doneHint(10), '直近 8 件')
  assert.equal(doneHint(undefined), '完了はまだありません')
})

// 注釈「この文言はなんですか？」: ラベルだけでは何の話か分からないので問番号と問いの文を添える
test('thumbCaption は問番号と選択肢、問いの文を返す', () => {
  const c = thumbCaption('Q2', { id: 'A', label: '塗りのボタン' }, '「＋ 注釈」への導線は、塗りのボタンか、文字リンクか')
  assert.equal(c.head, 'Q2 A. 塗りのボタン')
  assert.equal(c.sub, '「＋ 注釈」への導線は、塗りのボタンか、文字リンクか')
})

test('thumbCaption は欠けた入力でも崩れない（空白を残さない）', () => {
  assert.deepEqual(thumbCaption('Q1', { id: 'B' }), { head: 'Q1 B.', sub: '' })
  assert.deepEqual(thumbCaption('', { label: '枠付きカード' }, undefined), { head: '枠付きカード', sub: '' })
  assert.deepEqual(thumbCaption(undefined, undefined, null), { head: '', sub: '' })
})

// 画像一覧: 同じ画面のショットが並ぶので、取得日時とリポジトリ名が無いと選べない
test('capturedLabel はローカル時刻の MM/DD HH:mm を返す', () => {
  assert.equal(capturedLabel(new Date(2026, 10, 12, 21, 5).getTime()), '11/12 21:05')
  assert.equal(capturedLabel(new Date(2026, 0, 3, 9, 7).getTime()), '01/03 09:07')
  assert.equal(capturedLabel(undefined), '—')
  assert.equal(capturedLabel(0), '—')
  assert.equal(capturedLabel('abc'), '—')
})

test('repoLabel はリポジトリ id を出し、推定できなければ —', () => {
  assert.equal(repoLabel({ id: 'hermes-mobile-pwa', label: 'Mobile PWA' }), 'hermes-mobile-pwa')
  assert.equal(repoLabel({ label: 'Mobile PWA' }), 'Mobile PWA')
  assert.equal(repoLabel('nanokvm'), 'nanokvm')
  assert.equal(repoLabel(null), '—')
  assert.equal(repoLabel({}), '—')
})

// 下部ナビの丸バッジ（注釈 1377.jpg の赤）: 判断待ちの件数だけを数える
test('waitingCount はナビのバッジに出す赤ペン待ち件数（0 ならバッジを出さない）', () => {
  assert.equal(waitingCount([]), 0)
  assert.equal(waitingCount(undefined), 0)
  assert.equal(waitingCount([waitingItem('w1')]), 1)
  assert.equal(waitingCount([waitingItem('w1'), waitingItem('w2')]), 2)
  // 進行中・完了・label 無しの blocked はバッジに数えない
  assert.equal(waitingCount([activeItem('a1', 'ready'), activeItem('a2', 'running'), doneItem('d1')]), 0)
  assert.equal(waitingCount([{ id: 'b1', status: 'blocked', akapen: {} }]), 0)
  assert.equal(waitingCount([waitingItem('w1'), doneItem('d1'), activeItem('a1', 'review')]), 1)
  assert.equal(waitingCount([null, waitingItem('w9')]), 1)
})

test('pendingCount はナビのタスクタブに出す承認待ち件数', () => {
  assert.equal(pendingCount([]), 0)
  assert.equal(pendingCount(undefined), 0)
  assert.equal(pendingCount([{ id: 'x1', board: 'nanokvm' }]), 1)
  // 赤ペン待ちは /api/inbox 側で除かれるので、ここに来る items は承認待ちだけ
  assert.equal(pendingCount([{ id: 'x1', board: 'ffp' }, { id: 'x2', board: 'mobile' }]), 2)
  assert.equal(pendingCount([null, { id: 'x2' }]), 1)
})

// 完了の見える化（作業フィード）: 進行中は点、未読の完了は点、判断待ちだけ数字
test('runningCount は反映待ちと生成中を数える', () => {
  assert.equal(runningCount([]), 0)
  assert.equal(runningCount(undefined), 0)
  assert.equal(runningCount([{ status: 'running' }, { status: 'ready' }, doneItem('d1')]), 2)
  assert.equal(runningCount([waitingItem('w1')]), 0)
})

test('unseenNotices は lastSeen より新しい行だけ返す', () => {
  const feed = [
    { at: 1000, text: '✅ 完了 1' },
    { at: 2000, text: '✅ 完了 2' },
    { at: 3000, text: '⚠ 心拍停止' },
  ]
  assert.equal(unseenNotices(feed, 0).length, 3)
  assert.equal(unseenNotices(feed, 1000).length, 2)
  assert.equal(unseenNotices(feed, 3000).length, 0, '境界は既読扱い')
  assert.deepEqual(unseenNotices(undefined, 0), [])
})

test('navBadgeState は 判断待ち > 未読完了 > 進行中 の順で 1 つだけ返す', () => {
  assert.equal(navBadgeState({ waiting: 1, unseen: 2, running: 3 }), 'waiting')
  assert.equal(navBadgeState({ waiting: 0, unseen: 1, running: 2 }), 'done')
  assert.equal(navBadgeState({ waiting: 0, unseen: 0, running: 1 }), 'running')
  assert.equal(navBadgeState({}), null)
  assert.equal(navBadgeState(), null)
})

test('answerRows は回答を履歴の行にする（未回答は捏造せず choice=null）', () => {
  const data = {
    questions: [
      { id: 'q1', text: '完了報告を流すか', options: [{ id: 'A', label: 'チャットにも 1 行流す' }, { id: 'B', label: 'フィードだけ' }] },
      { id: 'q2', text: '紐づけをどちらで作るか', options: [{ id: 'A', label: 'タスクに会話 ID' }, { id: 'B', label: '監視役に宛先' }] },
    ],
  }
  const answer = { answers: [{ id: 'q1', choice: 'A', note: '短く' }], global: '履歴が見たい' }
  const { rows, global } = answerRows(data, answer)

  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { id: 'q1', question: '完了報告を流すか', choice: 'A', label: 'チャットにも 1 行流す', note: '短く' })
  assert.equal(rows[1].choice, null, '未回答の問はお任せ（既定）として扱う')
  assert.equal(rows[1].label, '', '選ばれていない選択肢のラベルは出さない')
  assert.equal(global, '履歴が見たい')

  const empty = answerRows(null, null)
  assert.deepEqual(empty.rows, [], 'データが無ければ空（画面を壊さない）')
  assert.equal(empty.global, '')
})
