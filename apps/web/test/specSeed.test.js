/**
 * `Spec Seed` の純粋ロジック検証（SPEC V5 §3.3 ① / D26①・SPEC V7 §3.3 / D33・D35）。
 *
 * 画面を描かずに、送信可否・実行方針・送信本文・ジョブ破棄の経路・A2B バナー選択を固定する。
 * Web Speech API のヘルパー（`recognitionCtor` / `speechLocale` / `mergeTranscript`）は
 * 音声を OS 標準へ一本化したため削除した（SPEC V7 §1.3）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_EXECUTION_POLICY,
  EXECUTION_POLICIES,
  SEED_MAX,
  TEMPLATE_IDS,
  buildSeedPayload,
  canSubmit,
  countRunningArchitect,
  dismissJobPath,
  elapsedParts,
  executionPolicyHintKey,
  executionPolicyKey,
  isQueuedJob,
  jobPhaseKey,
  jobPollMs,
  jobQueueKey,
  jobRunnerKey,
  jobSheetName,
  jobStatusKey,
  jobTitleKey,
  normalizeExecutionPolicy,
  pickActiveArchitectJob,
  pickSpecBanner,
  shouldOfferHermesRetry,
} from '../src/lib/specSeed.js'

test('送信可否は空文字と上限超えを弾く', () => {
  assert.equal(canSubmit('  '), false)
  assert.equal(canSubmit('通知をまとめたい'), true)
  assert.equal(canSubmit('x'.repeat(SEED_MAX)), true)
  assert.equal(canSubmit('x'.repeat(SEED_MAX + 1)), false)
})

test('実行方針は zero-stop 既定で、未知の値は既定へ落とす', () => {
  assert.deepEqual([...EXECUTION_POLICIES], ['zero-stop', 'visual-gate'])
  assert.equal(DEFAULT_EXECUTION_POLICY, 'zero-stop')
  assert.equal(normalizeExecutionPolicy(undefined), 'zero-stop')
  assert.equal(normalizeExecutionPolicy(''), 'zero-stop')
  assert.equal(normalizeExecutionPolicy('VISUAL-GATE'), 'visual-gate')
  assert.equal(normalizeExecutionPolicy(' visual-gate '), 'visual-gate')
  assert.equal(normalizeExecutionPolicy('zero-stop'), 'zero-stop')
  // 仕様に無い値（過去の別名・タイポ）は既定へ寄せる
  assert.equal(normalizeExecutionPolicy('fast'), 'zero-stop')
  assert.equal(normalizeExecutionPolicy(null), 'zero-stop')
})

test('実行方針のラベル・説明は i18n キーへ写像される', () => {
  assert.equal(executionPolicyKey('zero-stop'), 'seed.policyZeroStop')
  assert.equal(executionPolicyKey('visual-gate'), 'seed.policyVisualGate')
  assert.equal(executionPolicyKey('???'), 'seed.policyZeroStop')
  assert.equal(executionPolicyHintKey('zero-stop'), 'seed.policyZeroStopHint')
  assert.equal(executionPolicyHintKey('visual-gate'), 'seed.policyVisualGateHint')
  assert.equal(executionPolicyHintKey('???'), 'seed.policyZeroStopHint')
})

test('buildSeedPayload は runner を hermes 固定にし、任意項目だけ載せる', () => {
  assert.deepEqual(buildSeedPayload({ seedText: '  a  ', board: 'demo' }), {
    seedText: 'a',
    autoStart: false,
    executionPolicy: 'zero-stop',
    runner: 'hermes',
    lang: 'ja',
    board: 'demo',
  })
  const full = buildSeedPayload({
    seedText: 'x',
    autoStart: true,
    executionPolicy: 'visual-gate',
    board: 'demo',
    repo: 'hermes-pilot',
    chat: '20261113_221400_f9da52',
    lang: 'en',
  })
  assert.equal(full.autoStart, true)
  assert.equal(full.executionPolicy, 'visual-gate')
  assert.equal(full.runner, 'hermes')
  assert.equal(full.repo, 'hermes-pilot')
  assert.equal(full.chat, '20261113_221400_f9da52')
  assert.equal(full.lang, 'en')
  // V11 §3.3 / D51: ランナーは Hermes Native だけ。外から別の値を混ぜても hermes のまま
  assert.equal(buildSeedPayload({ seedText: 'x', runner: 'hermes' }).runner, 'hermes')
  // 未知の方針も既定へ落とす（Bridge 側 normalizeExecutionPolicy と同じ既定）
  assert.equal(buildSeedPayload({ seedText: 'x', executionPolicy: 'bogus' }).executionPolicy, 'zero-stop')
  // 上限で切る
  assert.equal(buildSeedPayload({ seedText: 'y'.repeat(SEED_MAX + 50) }).seedText.length, SEED_MAX)
})

test('テンプレートチップは 3 種（i18n のキーで引く）', () => {
  assert.deepEqual(TEMPLATE_IDS, ['feature', 'ux', 'bug'])
})

test('ジョブ状態は i18n キーへ写像される', () => {
  assert.equal(jobStatusKey('running'), 'seed.statusRunning')
  assert.equal(jobStatusKey('awaiting_review'), 'seed.statusAwaitingReview')
  assert.equal(jobStatusKey('awaiting_spec'), 'seed.statusAwaiting')
  assert.equal(jobStatusKey('spec_ready'), 'seed.statusReady')
  assert.equal(jobStatusKey('launched'), 'seed.statusLaunched')
  assert.equal(jobStatusKey('failed'), 'seed.statusFailed')
  assert.equal(jobStatusKey('???'), 'seed.statusUnknown')
})

test('キュー待ち（ready）と実行中（running）は別の表示になる', () => {
  // Bridge の queueState をそのまま写す（判定できないときは null）
  assert.equal(jobQueueKey({ status: 'running', queueState: 'queued' }), 'seed.queueQueued')
  assert.equal(jobQueueKey({ status: 'awaiting_spec', queueState: 'running' }), 'seed.queueRunning')
  assert.equal(jobQueueKey({ status: 'running', queueState: null }), null)
  assert.equal(jobQueueKey({ status: 'running' }), null)
  assert.equal(jobQueueKey(null), null)

  assert.equal(isQueuedJob({ queueState: 'queued' }), true)
  assert.equal(isQueuedJob({ queueState: 'running' }), false)
  assert.equal(isQueuedJob(null), false)

  // タイトルは待機中だけ「キュー待ち」へ差し替える（それ以外は従来の状態文）
  assert.equal(jobTitleKey({ status: 'running', queueState: 'queued' }), 'seed.statusQueued')
  assert.equal(jobTitleKey({ status: 'awaiting_spec', queueState: 'running' }), 'seed.statusAwaiting')
  assert.equal(jobTitleKey({ status: 'awaiting_spec' }), 'seed.statusAwaiting')
})

test('ジョブ破棄は /api/architect/jobs/:id/dismiss を叩く', () => {
  assert.equal(dismissJobPath('arch-1'), '/api/architect/jobs/arch-1/dismiss')
  // ID は URL エンコードする（パスを壊す文字を素通ししない）
  assert.equal(dismissJobPath('a/b c'), '/api/architect/jobs/a%2Fb%20c/dismiss')
  assert.equal(dismissJobPath(undefined), '/api/architect/jobs//dismiss')
})

test('進行バーに出すジョブは進行中と失敗だけを新しい順に 1 件選ぶ', () => {
  assert.equal(pickActiveArchitectJob(null), null)
  assert.equal(pickActiveArchitectJob([]), null)

  // spec_ready / launched は SpecReadyBanner が引き継ぐので進行バーには出さない
  assert.equal(
    pickActiveArchitectJob([
      { id: 'a', status: 'spec_ready', createdAt: 200 },
      { id: 'b', status: 'launched', createdAt: 300 },
    ]),
    null,
  )

  const jobs = [
    { id: 'old', status: 'failed', createdAt: 100 },
    { id: 'run', status: 'running', createdAt: 300 },
    { id: 'rev', status: 'awaiting_review', createdAt: 200 },
    { id: 'ready', status: 'spec_ready', createdAt: 400 },
  ]
  // 新しい running を優先（古い failed で画面を占有しない）
  assert.equal(pickActiveArchitectJob(jobs).id, 'run')
  // 閉じたものは飛ばす
  assert.equal(pickActiveArchitectJob(jobs, ['run']).id, 'rev')
  assert.equal(pickActiveArchitectJob(jobs, ['run', 'rev']).id, 'old')
  assert.equal(pickActiveArchitectJob(jobs, ['run', 'rev', 'old']), null)

  // サーバー側で破棄済み（dismissed）のジョブは、ローカル状態が消えても出さない
  // （リロード後に再出現しないことを、取得結果だけでも担保する）
  assert.equal(
    pickActiveArchitectJob([{ id: 'x', status: 'running', createdAt: 900, dismissed: true }]),
    null,
  )
  assert.equal(
    pickActiveArchitectJob([
      { id: 'x', status: 'running', createdAt: 900, dismissed: true },
      { id: 'y', status: 'running', createdAt: 800 },
    ]).id,
    'y',
  )

  // 同時刻なら failed を先に見せる（止まっているものを隠さない）
  assert.equal(
    pickActiveArchitectJob([
      { id: 'spec', status: 'awaiting_spec', createdAt: 500 },
      { id: 'bad', status: 'failed', createdAt: 500 },
    ]).id,
    'bad',
  )
})

test('ポーリングは自律進行の 4 秒／人待ちの 20 秒（キュー待ちは 4 秒）', () => {
  assert.equal(jobPollMs({ status: 'running' }), 4000)
  assert.equal(jobPollMs({ status: 'awaiting_spec' }), 4000)
  assert.equal(jobPollMs({ status: 'awaiting_review' }), 20000)
  assert.equal(jobPollMs({ status: 'failed' }), 20000)
  assert.equal(jobPollMs(null), 20000)
  // キュー待ちはディスパッチャ待ち。実行中へ変わった瞬間を拾うため短い側に置く
  assert.equal(jobPollMs({ status: 'running', queueState: 'queued' }), 4000)
  assert.equal(jobPollMs({ status: 'awaiting_spec', queueState: 'queued' }), 4000)
})

test('ランナー表示は Hermes Native 固定（V11 D51）', () => {
  assert.equal(jobRunnerKey({ runner: 'hermes' }), 'seed.runnerHermes')
  assert.equal(jobRunnerKey({}), 'seed.runnerHermes')
  assert.equal(jobRunnerKey(null), 'seed.runnerHermes')
  // V11 で agy フォールバックは廃止。古いジョブに残る fallbackFrom でも表示は Hermes Native
  assert.equal(jobRunnerKey({ runner: 'hermes', fallbackFrom: null }), 'seed.runnerHermes')
})

test('経過時間は時・分・秒へ分解される', () => {
  assert.deepEqual(elapsedParts(0), { h: 0, m: 0, s: 0 })
  assert.deepEqual(elapsedParts(-5000), { h: 0, m: 0, s: 0 })
  assert.deepEqual(elapsedParts(42_000), { h: 0, m: 0, s: 42 })
  assert.deepEqual(elapsedParts(3 * 60_000 + 12_000), { h: 0, m: 3, s: 12 })
  assert.deepEqual(elapsedParts(3600_000 * 2 + 60_000 * 5 + 9_000), { h: 2, m: 5, s: 9 })
  assert.deepEqual(elapsedParts(undefined), { h: 0, m: 0, s: 0 })
})

test('A2B バナーは完成 SPEC を優先し、起票済みは出さない', () => {
  assert.equal(pickSpecBanner({}), null)

  const ready = pickSpecBanner({
    specReady: [
      { jobId: 'j2', spec: 'docs/SPEC-DONE.md', title: 'done', batchCount: 3, launched: true },
      {
        jobId: 'j1',
        spec: 'docs/SPEC-V5.md',
        title: 'V5',
        batchCount: 4,
        autoStart: false,
        batches: [{ id: 'V5-1' }, { id: 'V5-2' }, { id: 'V5-3' }, { id: 'V5-4' }],
      },
    ],
    pending: [{ path: 'docs/SPEC-OLD.md', title: 'old', pendingCount: 2, pending: ['A', 'B'] }],
  })
  assert.deepEqual(ready, {
    kind: 'ready',
    path: 'docs/SPEC-V5.md',
    title: 'V5',
    count: 4,
    ids: ['V5-1', 'V5-2', 'V5-3', 'V5-4'],
    jobId: 'j1',
    autoStart: false,
    board: null,
  })

  // ジョブのボードは仕様書プレビューのリポジトリ解決に使う（V6-4 / D30）
  const withBoard = pickSpecBanner({
    specReady: [{ jobId: 'j3', spec: 'docs/SPEC-V6.md', title: 'V6', batchCount: 2, board: 'hermes-pilot' }],
  })
  assert.equal(withBoard.board, 'hermes-pilot')

  const pendingOnly = pickSpecBanner({
    pending: [{ path: 'docs/SPEC-OLD.md', title: 'old', pendingCount: 2, pending: ['A', 'B'] }],
  })
  assert.equal(pendingOnly.kind, 'pending')
  assert.equal(pendingOnly.count, 2)
  assert.deepEqual(pendingOnly.ids, ['A', 'B'])

  // 全部起票済みならカードは出ない
  assert.equal(
    pickSpecBanner({ specReady: [{ spec: 'docs/S.md', batchCount: 2, launched: true }], pending: [] }),
    null,
  )
})

test('進行バーは表示中ボードのジョブを優先し、無ければ別ボードでフォールバックする', () => {
  const jobs = [
    { id: 'pilot', board: 'hermes-pilot', status: 'running', createdAt: 300 },
    { id: 'mobile', board: 'mobile', status: 'awaiting_spec', createdAt: 200 },
  ]
  // 表示中ボードがあれば、古くてもそのボードを出す（見ている画面の文脈を優先）
  assert.equal(pickActiveArchitectJob(jobs, [], 'mobile').id, 'mobile')
  assert.equal(pickActiveArchitectJob(jobs, [], 'hermes-pilot').id, 'pilot')
  // そのボードにジョブが無ければ別ボードのアクティブジョブを出す（バーを消さない・D42/D43）
  assert.equal(pickActiveArchitectJob(jobs, [], 'other-board').id, 'pilot')
  // 優先ボード未指定・空文字は従来の並び（新しい順）
  assert.equal(pickActiveArchitectJob(jobs).id, 'pilot')
  assert.equal(pickActiveArchitectJob(jobs, [], '').id, 'pilot')
  // 閉じたジョブは優先ボードにあっても飛ばす
  assert.equal(pickActiveArchitectJob(jobs, ['mobile'], 'mobile').id, 'pilot')
})

test('ジョブのフェーズは i18n キーへ写像され、未知は出さない', () => {
  assert.equal(jobPhaseKey({ phase: 'spawning' }), 'seed.phaseSpawning')
  assert.equal(jobPhaseKey({ phase: 'round1_sheet' }), 'seed.phaseRound1Sheet')
  assert.equal(jobPhaseKey({ phase: 'awaiting_review' }), 'seed.statusAwaitingReview')
  assert.equal(jobPhaseKey({ phase: 'round2_spec' }), 'seed.phaseRound2Spec')
  assert.equal(jobPhaseKey({ phase: 'spec_ready' }), 'seed.statusReady')
  assert.equal(jobPhaseKey({ phase: 'launched' }), 'seed.statusLaunched')
  assert.equal(jobPhaseKey({ phase: 'failed' }), 'seed.statusFailed')
  // 旧ブリッジ（phase 無し）・未知値は札を出さない
  assert.equal(jobPhaseKey({ status: 'running' }), null)
  assert.equal(jobPhaseKey({ phase: 'nope' }), null)
  assert.equal(jobPhaseKey(null), null)
})

test('検知済みシートの表示名はファイル名だけを取り出す', () => {
  assert.equal(jobSheetName({ sheetPath: 'review/sheets/spec-notify-1.json' }), 'spec-notify-1.json')
  assert.equal(jobSheetName({ sheetPath: 'sheets\\spec-a-2.json' }), 'spec-a-2.json')
  assert.equal(jobSheetName({ sheetPath: 'spec-x.json' }), 'spec-x.json')
  assert.equal(jobSheetName({ sheetPath: '  ' }), '')
  assert.equal(jobSheetName({}), '')
  assert.equal(jobSheetName(null), '')
})

test('Hermes Native の再試行は失敗・停滞のときに明示ボタンにする（V11 D54）', () => {
  // 失敗は必ず出す（止まったものを黙って放置しない）
  assert.equal(shouldOfferHermesRetry({ status: 'failed', runner: 'hermes' }), true)
  assert.equal(shouldOfferHermesRetry({ status: 'failed', runner: 'hermes', stalled: false }), true)
  // 3 分以上進捗が無い（stalled）なら、動いているか不明なので逃げ道を出す
  assert.equal(shouldOfferHermesRetry({ status: 'running', runner: 'hermes', stalled: true }), true)
  assert.equal(shouldOfferHermesRetry({ status: 'awaiting_spec', runner: 'hermes', stalled: true }), true)
  // 停滞していない実行中ジョブには出さない（勝手に二重起動しない）
  assert.equal(shouldOfferHermesRetry({ status: 'running', runner: 'hermes', stalled: false }), false)
  // Review の回答待ちは人の操作で進むので出さない
  assert.equal(shouldOfferHermesRetry({ status: 'awaiting_review', runner: 'hermes' }), false)
  assert.equal(shouldOfferHermesRetry(null), false)
})

test('稼働中の Architect 件数は running / awaiting_spec だけを数える', () => {
  assert.equal(countRunningArchitect(null), 0)
  assert.equal(countRunningArchitect([]), 0)
  assert.equal(
    countRunningArchitect([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'awaiting_spec' },
      // 判断待ちは 🔔 の担当なので数えない（`/api/live` の counts.architect と同じ規則）
      { id: 'c', status: 'awaiting_review' },
      { id: 'd', status: 'spec_ready' },
      { id: 'e', status: 'failed' },
      // 破棄済みは数えない
      { id: 'f', status: 'running', dismissed: true },
    ]),
    2,
  )
})
