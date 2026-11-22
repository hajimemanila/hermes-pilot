import test from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../src/i18n/lang.js'
import {
  DONE_LIMIT,
  REVIEW_STATUS_KEY,
  answerRows,
  appBadgeCount,
  capturedLabel,
  doneHint,
  extractRecommendedAnswers,
  groupItems,
  isAnswered,
  isAnsweredReview,
  isGenerating,
  isRecommendedOption,
  isReflecting,
  isWaiting,
  navBadgeState,
  nextWaiting,
  pendingCount,
  repoLabel,
  reviewChipKey,
  reviewPhase,
  reviewProgressText,
  reviewTabFor,
  runningCount,
  shouldFetchSheetData,
  shouldShowModeChip,
  thumbCaption,
  unseenNotices,
  waitingCount,
} from '../src/lib/reviewView.js'

/** レビュー待ち（blocked + label）。 */
const waitingItem = (id) => ({ id, status: 'blocked', review: { label: 'review-view-01', round: 1 } })
/** 進行中（回答できない）。 */
const activeItem = (id, status) => ({ id, status, review: { label: 'x' } })
/** 完了。 */
const doneItem = (id) => ({ id, status: 'done', review: { label: 'x' } })

test('isWaiting は blocked かつ label 付きだけをレビュー待ちとする', () => {
  assert.equal(isWaiting(waitingItem('t1')), true)
  assert.equal(isWaiting({ id: 't2', status: 'blocked', review: {} }), false, 'label 無しは待ちではない')
  assert.equal(isWaiting({ id: 't3', status: 'ready', review: { label: 'x' } }), false, 'ready は待ちではない')
  assert.equal(isWaiting({ id: 't4', status: 'review', review: { label: 'x' } }), false, 'review は回答を受けない')
  assert.equal(isWaiting(null), false)
})

test('groupItems: 生成中 / 判断待ち / 反映中 / 完了 に分かれ、完了は直近 8 件だけ（総数は別に持つ）', () => {
  const items = [
    waitingItem('w1'),
    waitingItem('w2'),
    { id: 'g1', status: 'ready', review: { label: 'x' } },
    { id: 'g2', status: 'running', review: { label: 'x' } },
    { id: 'g3', status: 'blocked', review: { label: null } },
    { id: 'g4', status: 'review', review: { label: 'x' } },
    { id: 'f1', status: 'ready', review: { label: 'y', answeredAt: '2026-11-22T10:00:00Z' } },
    { id: 'f2', status: 'running', review: { label: 'y', answeredAt: '2026-11-22T10:05:00Z' } },
    ...Array.from({ length: 10 }, (_, i) => doneItem(`d${i}`)),
  ]
  const g = groupItems(items)

  assert.deepEqual(g.generating.map((i) => i.id), ['g1', 'g2', 'g3', 'g4'])
  assert.deepEqual(g.waiting.map((i) => i.id), ['w1', 'w2'])
  assert.deepEqual(g.reflecting.map((i) => i.id), ['f1', 'f2'])
  assert.deepEqual(g.active.map((i) => i.id), ['g1', 'g2', 'g3', 'g4', 'f1', 'f2'])
  assert.equal(g.done.length, DONE_LIMIT, '完了タブは直近 8 件まで')
  assert.equal(g.doneTotal, 10, '総数は偽らない（チップに件数を出さない根拠）')
  assert.deepEqual(g.done.map((i) => i.id), ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'])
})

test('groupItems は空・壊れた入力を落とさない', () => {
  assert.deepEqual(groupItems(undefined), {
    generating: [],
    waiting: [],
    reflecting: [],
    active: [],
    done: [],
    doneTotal: 0,
  })
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
  setLang('ja')
  assert.equal(doneHint(0), '完了はまだありません')
  assert.equal(doneHint(3), '直近 3 件')
  assert.equal(doneHint(10), '直近 8 件')
  assert.equal(doneHint(undefined), '完了はまだありません')
  setLang('en')
  assert.equal(doneHint(0), 'No completed reviews yet')
  assert.equal(doneHint(3), 'Last 3')
  assert.equal(doneHint(10), 'Last 8')
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
  assert.equal(repoLabel('sample-app'), 'sample-app')
  assert.equal(repoLabel(null), '—')
  assert.equal(repoLabel({}), '—')
})

// 下部ナビの丸バッジ（注釈 1377.jpg の赤）: 判断待ちの件数だけを数える
test('waitingCount はナビのバッジに出すレビュー待ち件数（0 ならバッジを出さない）', () => {
  assert.equal(waitingCount([]), 0)
  assert.equal(waitingCount(undefined), 0)
  assert.equal(waitingCount([waitingItem('w1')]), 1)
  assert.equal(waitingCount([waitingItem('w1'), waitingItem('w2')]), 2)
  // 進行中・完了・label 無しの blocked はバッジに数えない
  assert.equal(waitingCount([activeItem('a1', 'ready'), activeItem('a2', 'running'), doneItem('d1')]), 0)
  assert.equal(waitingCount([{ id: 'b1', status: 'blocked', review: {} }]), 0)
  assert.equal(waitingCount([waitingItem('w1'), doneItem('d1'), activeItem('a1', 'review')]), 1)
  assert.equal(waitingCount([null, waitingItem('w9')]), 1)
})

test('pendingCount はナビのタスクタブに出す未回答の承認待ち件数', () => {
  assert.equal(pendingCount([]), 0)
  assert.equal(pendingCount(undefined), 0)
  assert.equal(pendingCount([{ id: 'x1', board: 'sample-app' }]), 1)
  // レビュー待ちは /api/inbox 側で除かれるので、ここに来る items は承認待ちだけ
  assert.equal(pendingCount([{ id: 'x1', board: 'ffp' }, { id: 'x2', board: 'mobile' }]), 2)
  assert.equal(pendingCount([null, { id: 'x2' }]), 1)
  // 回答済み（mobile が blocked 以降にコメント済み）はバッジ件数から除外する
  const answered = { id: 'x3', blockedAt: 1000, lastComment: { author: 'mobile', at: 1000 } }
  const olderReply = { id: 'x4', blockedAt: 2000, lastComment: { author: 'mobile', at: 1500 } }
  const agentComment = { id: 'x5', blockedAt: 1000, lastComment: { author: 'worker', at: 1500 } }
  assert.equal(isAnswered(answered), true)
  assert.equal(isAnswered(olderReply), false)
  assert.equal(isAnswered(agentComment), false)
  assert.equal(pendingCount([answered, olderReply, agentComment]), 2)
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

/** 設問の雛形（options を差し替えて境界を作る）。 */
const q = (id, options) => ({ id, text: `${id} の問い`, options })

test('extractRecommendedAnswers: 推奨が全部なら全問ぶんの選択肢を返す', () => {
  const sheet = {
    questions: [
      q('q1', [{ id: 'A', label: '塗り', recommended: true }, { id: 'B', label: '線' }]),
      q('q2', [{ id: 'A', label: '左' }, { id: 'B', label: '右', recommended: true }]),
    ],
  }
  const r = extractRecommendedAnswers(sheet)
  assert.equal(r.canFastTrack, true)
  assert.equal(r.summary, 'Q1:A · Q2:B')
  assert.deepEqual(r.answers, [
    { id: 'q1', choice: 'A', note: '' },
    { id: 'q2', choice: 'B', note: '' },
  ])
})

test('extractRecommendedAnswers: 推奨が一部なら、無い問は choice:null（お任せ）で送る', () => {
  const sheet = {
    questions: [
      q('q1', [{ id: 'A', label: '塗り', recommended: true }]),
      q('q2', [{ id: 'A', label: '左' }, { id: 'B', label: '右' }]),
    ],
  }
  const r = extractRecommendedAnswers(sheet)
  assert.equal(r.canFastTrack, true, '1 問でも推奨があれば一括承認できる')
  assert.equal(r.summary, 'Q1:A', 'summary は推奨のある問だけ')
  assert.deepEqual(r.answers[1], { id: 'q2', choice: null, note: '' }, '推奨の無い問はお任せ')
})

test('extractRecommendedAnswers: 推奨が 1 つも無ければ一括承認を出さない', () => {
  const r = extractRecommendedAnswers({ questions: [q('q1', [{ id: 'A' }, { id: 'B' }])] })
  assert.equal(r.canFastTrack, false)
  assert.equal(r.summary, '')
  assert.deepEqual(r.answers, [{ id: 'q1', choice: null, note: '' }], '送信形は保つ（未選択＝お任せ）')
})

test('extractRecommendedAnswers: ラベルに「推奨」/ Recommended を含む選択肢も推奨として扱う', () => {
  const ja = extractRecommendedAnswers({
    questions: [q('q1', [{ id: 'A', label: '塗りボタン' }, { id: 'B', label: '線ボタン（推奨）' }])],
  })
  assert.equal(ja.canFastTrack, true, 'recommended フラグが無くてもラベルで判定する')
  assert.equal(ja.summary, 'Q1:B')

  const en = extractRecommendedAnswers({
    questions: [q('q1', [{ id: 'A', label: 'Recommended: filled' }, { id: 'B', label: 'Outline' }])],
  })
  assert.equal(en.summary, 'Q1:A')

  const flagString = extractRecommendedAnswers({ questions: [q('q1', [{ id: 'C', recommended: 'true' }])] })
  assert.equal(flagString.summary, 'Q1:C', '文字列の "true" も推奨として受ける')
})

test('extractRecommendedAnswers: 空・壊れた入力で落ちない', () => {
  for (const bad of [null, undefined, {}, { questions: null }, { questions: [null, {}] }]) {
    const r = extractRecommendedAnswers(bad)
    assert.equal(r.canFastTrack, false)
    assert.equal(r.summary, '')
    assert.ok(Array.isArray(r.answers))
  }
  assert.deepEqual(extractRecommendedAnswers({ questions: [{ id: 'x' }] }).answers, [{ id: 'x', choice: null, note: '' }])
})

test('isRecommendedOption は recommended フラグとラベルの両方を見る（否定は除く）', () => {
  assert.equal(isRecommendedOption({ id: 'A', recommended: true }), true)
  assert.equal(isRecommendedOption({ id: 'A', recommended: 'true' }), true)
  assert.equal(isRecommendedOption({ id: 'A', label: '推奨案' }), true)
  assert.equal(isRecommendedOption({ id: 'A', label: 'no recommendation' }), false, '「no recommend…」は推奨ではない')
  assert.equal(isRecommendedOption({ id: 'A', label: '非推奨' }), false, '「非推奨」は推奨ではない')
  assert.equal(isRecommendedOption(null), false)
})

test('appBadgeCount は 判断待ち＋承認待ち の合計（0 なら 0 = clearAppBadge）', () => {
  assert.equal(appBadgeCount({ reviewWaiting: 2, inboxPending: 3 }), 5, '人が対応すべき合計を出す')
  assert.equal(appBadgeCount({ reviewWaiting: 0, inboxPending: 1 }), 1)
  assert.equal(appBadgeCount({ reviewWaiting: 4, inboxPending: 0 }), 4)
  assert.equal(appBadgeCount({ reviewWaiting: 0, inboxPending: 0 }), 0, '0 のときは数字を出さない（clear）')
})

test('appBadgeCount は実行中タスク数を混ぜない（旧仕様の回帰防止）', () => {
  assert.equal(appBadgeCount({ reviewWaiting: 0, inboxPending: 0, runningTasks: 7 }), 0)
  assert.equal(appBadgeCount({ reviewWaiting: 1, inboxPending: 0, runningTasks: 9 }), 1)
})

test('appBadgeCount は壊れた入力で NaN を出さない', () => {
  assert.equal(appBadgeCount(), 0)
  assert.equal(appBadgeCount({ reviewWaiting: null, inboxPending: undefined }), 0)
  assert.equal(appBadgeCount({ reviewWaiting: '3', inboxPending: 'x' }), 3, '数値文字列は読む')
  assert.equal(appBadgeCount({ reviewWaiting: -5, inboxPending: 2 }), 2)
})

test('shouldFetchSheetData: 注釈以外は設問 JSON を取りに行く（mode=sheet のデグレ防止）', () => {
  assert.equal(shouldFetchSheetData({ mode: 'sheet', sheet: 'sheets/a-1.json' }), true, 'mode=sheet でも取る（D38 の本体）')
  assert.equal(shouldFetchSheetData({ mode: 'standard' }), true)
  assert.equal(shouldFetchSheetData({ label: 'x' }), true, 'mode 未指定は取る（既定の構造化シート）')
  assert.equal(shouldFetchSheetData({ mode: 'annotation', image: 'shots/a.png' }), false, '注釈は設問 JSON を持たない')
  assert.equal(shouldFetchSheetData(null), true, '壊れた入力でも落ちない（openItem のエラー処理に任せる）')
})

test('shouldShowModeChip: 既定の表示形式（standard / sheet）はバッジを出さない', () => {
  assert.equal(shouldShowModeChip('sheet'), false, '`sheet` バッジは人に何も伝えないので出さない')
  assert.equal(shouldShowModeChip('standard'), false)
  assert.equal(shouldShowModeChip('annotation'), true, '特殊モードだけ出す')
  assert.equal(shouldShowModeChip(''), false)
  assert.equal(shouldShowModeChip(null), false)
  assert.equal(shouldShowModeChip(undefined), false)
})

test('4段階分類 (reviewPhase / reviewChipKey / reviewProgressText / reviewTabFor) と exists:false ガード（問題①・②）', () => {
  setLang('ja')
  assert.equal(REVIEW_STATUS_KEY.running, 'review.status.running')

  // sheet 不在 (exists:false) は blocked でも判断待ちに出さない（生成中扱い）
  const unreadySheet = { id: 't1', status: 'blocked', review: { label: 's1', sheet: 'sheets/s1.html', exists: false } }
  assert.equal(isWaiting(unreadySheet), false)
  assert.equal(reviewPhase(unreadySheet), 'generating')
  assert.equal(isGenerating(unreadySheet), true)
  assert.equal(reviewTabFor(unreadySheet), 'generating')

  // annotation モードは sheet 不要で waiting
  const annoWait = { id: 't2', status: 'blocked', review: { label: 'a1', mode: 'annotation' } }
  assert.equal(isWaiting(annoWait), true)
  assert.equal(reviewPhase(annoWait), 'waiting')
  assert.equal(reviewChipKey(annoWait), 'review.progress.waiting')

  // 未回答 running / ready は生成中
  const genRun = { id: 't3', status: 'running', review: { label: 's2' } }
  assert.equal(isAnsweredReview(genRun), false)
  assert.equal(reviewPhase(genRun), 'generating')
  assert.equal(reviewChipKey(genRun), 'review.status.running')
  assert.match(reviewProgressText(genRun, '・', 1000), /^生成中/)

  const genReady = { id: 't4', status: 'ready', review: { label: 's3' } }
  assert.equal(reviewPhase(genReady), 'generating')
  assert.equal(reviewChipKey(genReady), 'review.status.queuedGenerate')
  assert.match(reviewProgressText(genReady, '・', 1000), /^生成待ち/)

  // 回答済み running / ready は反映中（右タグも「反映中」/「反映待ち」で揃う）
  const refRun = { id: 't5', status: 'running', review: { label: 's4', answeredAt: '2026-11-22T10:00:00Z' } }
  assert.equal(isAnsweredReview(refRun), true)
  assert.equal(reviewPhase(refRun), 'reflecting')
  assert.equal(isReflecting(refRun), true)
  assert.equal(reviewTabFor(refRun), 'reflecting')
  assert.equal(reviewChipKey(refRun), 'review.progress.reflecting')
  assert.match(reviewProgressText(refRun, '・', 1000), /^反映中/)

  const refReady = { id: 't6', status: 'ready', review: { label: 's5', answeredAt: '2026-11-22T10:00:00Z' } }
  assert.equal(reviewPhase(refReady), 'reflecting')
  assert.equal(reviewChipKey(refReady), 'review.status.ready')
  assert.match(reviewProgressText(refReady, '・', 1000), /^反映待ち/)

  // done
  const done = { id: 't7', status: 'done', review: { label: 's6', answeredAt: '2026-11-22T10:00:00Z' } }
  assert.equal(reviewPhase(done), 'done')
  assert.equal(reviewChipKey(done), 'review.status.done')
  assert.equal(reviewTabFor(done), 'done')
})
