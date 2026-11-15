/**
 * `🎙️ Spec Seed` の純粋ロジック検証（SPEC V5 §3.3 ① / D26①）。
 *
 * 画面を描かずに、送信可否・音声言語・送信本文・A2B バナー選択を固定する。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SEED_MAX,
  TEMPLATE_IDS,
  buildSeedPayload,
  canSubmit,
  elapsedParts,
  jobPollMs,
  jobRunnerKey,
  jobStatusKey,
  mergeTranscript,
  pickActiveArchitectJob,
  pickSpecBanner,
  recognitionCtor,
  speechLocale,
} from '../src/lib/specSeed.js'

test('音声認識は UI 言語に追従し、未対応ブラウザでは null', () => {
  assert.equal(speechLocale('ja'), 'ja-JP')
  assert.equal(speechLocale('en'), 'en-US')
  assert.equal(speechLocale(undefined), 'en-US')

  const Fake = function FakeSpeech() {}
  assert.equal(recognitionCtor({ SpeechRecognition: Fake }), Fake)
  assert.equal(recognitionCtor({ webkitSpeechRecognition: Fake }), Fake)
  assert.equal(recognitionCtor({}), null)
  assert.equal(recognitionCtor(null), null)
})

test('送信可否は空文字と上限超えを弾く', () => {
  assert.equal(canSubmit('  '), false)
  assert.equal(canSubmit('通知をまとめたい'), true)
  assert.equal(canSubmit('x'.repeat(SEED_MAX)), true)
  assert.equal(canSubmit('x'.repeat(SEED_MAX + 1)), false)
})

test('暫定文の合成は日本語で空白を挟まない', () => {
  assert.equal(mergeTranscript('', 'こんにちは'), 'こんにちは')
  assert.equal(mergeTranscript('通知を', 'まとめたい'), '通知をまとめたい')
  assert.equal(mergeTranscript('add a', 'badge'), 'add a badge')
  assert.equal(mergeTranscript('add a', ''), 'add a')
})

test('buildSeedPayload は runner/lang を正規化し、任意項目だけ載せる', () => {
  assert.deepEqual(buildSeedPayload({ seedText: '  a  ', board: 'demo' }), {
    seedText: 'a',
    autoStart: false,
    runner: 'hermes',
    lang: 'ja',
    board: 'demo',
  })
  const full = buildSeedPayload({
    seedText: 'x',
    autoStart: true,
    runner: 'antigravity',
    board: 'demo',
    repo: 'hermes-pilot',
    chat: '20261113_221400_f9da52',
    lang: 'en',
  })
  assert.equal(full.autoStart, true)
  assert.equal(full.runner, 'antigravity')
  assert.equal(full.repo, 'hermes-pilot')
  assert.equal(full.chat, '20261113_221400_f9da52')
  assert.equal(full.lang, 'en')
  // 未知の runner は既定へ落とす（存在しないランナーを送らない）
  assert.equal(buildSeedPayload({ seedText: 'x', runner: 'gpt' }).runner, 'hermes')
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

  // 同時刻なら failed を先に見せる（止まっているものを隠さない）
  assert.equal(
    pickActiveArchitectJob([
      { id: 'spec', status: 'awaiting_spec', createdAt: 500 },
      { id: 'bad', status: 'failed', createdAt: 500 },
    ]).id,
    'bad',
  )
})

test('ポーリングは自律進行の 4 秒／人待ちの 20 秒', () => {
  assert.equal(jobPollMs({ status: 'running' }), 4000)
  assert.equal(jobPollMs({ status: 'awaiting_spec' }), 4000)
  assert.equal(jobPollMs({ status: 'awaiting_review' }), 20000)
  assert.equal(jobPollMs({ status: 'failed' }), 20000)
  assert.equal(jobPollMs(null), 20000)
})

test('ランナー表示は agy からの自動フォールバックを隠さない', () => {
  assert.equal(jobRunnerKey({ runner: 'hermes' }), 'seed.runnerHermes')
  assert.equal(jobRunnerKey({ runner: 'antigravity' }), 'seed.runnerAgy')
  assert.equal(jobRunnerKey({ runner: 'hermes', fallbackFrom: 'antigravity' }), 'seed.runnerFallback')
  assert.equal(jobRunnerKey(null), 'seed.runnerHermes')
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
