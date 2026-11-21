/**
 * Spec Launchpad の進捗判定（Q3=A: 全バッチ完了 → ✅ カード → 履歴）。
 *
 * カードの見た目と行き先は `specProgress()` の戻り値だけで決まるため、
 * 「起票済みだが未完走」を完了と誤判定しないことをここで固定する。
 *
 * SPEC-RELIABILITY-GUARD D91 / D92 の受入条件をこのファイルで固定する:
 *  「別 SPEC 衝突除外」「無印タスクの時刻ガード」「`runTaskIds` 最優先」「`archived` ≠ `done` 再起票可」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SPEC_MTIME_SLACK_MS,
  batchHeaderIdOf,
  batchIdOf,
  specProgress,
  taskSpecOf,
  taskTimeMs,
} from '../src/lib/specProgress.js'

const batches = [{ id: 'B1' }, { id: 'B2' }]
const task = (title, status) => ({ title, status })

test('batchIdOf はタイトル先頭の [ID] だけを拾う', () => {
  assert.equal(batchIdOf('[B1] 縦リスト化'), 'B1')
  assert.equal(batchIdOf('[spec-picker-01] 赤ペン'), 'spec-picker-01')
  assert.equal(batchIdOf('B1 だけのタイトル'), null)
  assert.equal(batchIdOf('前置き [B1] タイトル'), null)
  assert.equal(batchIdOf(null), null)
})

test('batchHeaderIdOf / taskSpecOf / taskTimeMs は本文の固定ヘッダを読む', () => {
  const t = {
    title: 'Renamed title without an id',
    body: 'Spec: docs/SPEC-RG.md\nTarget: /r\nBoard: mobile\nBatch: RG-1 — first\nMode: zero-stop\n',
    createdAt: 1_700_000_000_000,
    completedAt: 1_700_000_100,
  }
  assert.equal(batchHeaderIdOf(t), 'RG-1')
  assert.equal(taskSpecOf(t), 'docs/SPEC-RG.md')
  // 秒で来た completedAt は ms に揃える（1e12 未満は秒）
  assert.equal(taskTimeMs(t), 1_700_000_100_000)
})

test('未起票なら allFiled / allDone はどちらも false', () => {
  const p = specProgress(batches, [])
  assert.equal(p.allFiled, false)
  assert.equal(p.allDone, false)
  assert.equal(p.byId.size, 0)
})

test('一部だけ起票済みなら全バッチ完了にしない', () => {
  const p = specProgress(batches, [task('[B1] 一', 'done')])
  assert.equal(p.allFiled, false)
  assert.equal(p.allDone, false)
})

test('全バッチ起票済みでも未完了があれば ✅ にしない', () => {
  const tasks = [task('[B1] 一', 'done'), task('[B2] 二', 'running')]
  const p = specProgress(batches, tasks)
  assert.equal(p.allFiled, true)
  assert.equal(p.allDone, false)
})

test('archived は完了扱いにしない（破棄済みバッチは再起票できる・D92）', () => {
  const tasks = [task('[B1] 一', 'done'), task('[B2] 二', 'archived')]
  const p = specProgress(batches, tasks)
  assert.equal(p.allFiled, true)
  assert.equal(p.allDone, false, 'archived を done と数えない')
  // 起票シートの既定選択は「未起票」を選ぶので、archived はそのまま byId に残して状態を見せる
  assert.equal(p.byId.get('B2')?.status, 'archived')
})

test('全バッチが done のときだけ ✅ になる', () => {
  const p = specProgress(batches, [task('[B1] 一', 'done'), task('[B2] 二', 'done')])
  assert.equal(p.allDone, true)
})

test('バッチが 0 件なら完了を名乗らない', () => {
  const p = specProgress([], [task('[B1] 一', 'done')])
  assert.equal(p.allFiled, false)
  assert.equal(p.allDone, false)
})

test('同じバッチ ID が複数あるときは done ＞ オープン ＞ archived の順で残す', () => {
  const doneFirst = specProgress(
    [{ id: 'B1' }],
    [task('[B1] 一', 'done'), task('[B1] 再起票', 'running')],
  )
  assert.equal(doneFirst.byId.get('B1')?.status, 'done')
  assert.equal(doneFirst.allDone, true)

  const openFirst = specProgress(
    [{ id: 'B1' }],
    [task('[B1] 一', 'archived'), task('[B1] 再起票', 'running'), task('[B1] 三', 'done')],
  )
  assert.equal(openFirst.byId.get('B1')?.status, 'done', 'done が archived / running に勝つ')

  const archivedOnly = specProgress([{ id: 'B1' }], [task('[B1] 一', 'archived')])
  assert.equal(archivedOnly.byId.get('B1')?.status, 'archived')
  assert.equal(archivedOnly.allDone, false)
})

test('specRelPath 指定時は別 SPEC の同名バッチ ID と衝突しない', () => {
  const cohBatches = [{ id: 'C1' }, { id: 'C2' }]
  const tasks = [
    { title: '[C1] Catalog admission', status: 'done', spec: 'docs/SPEC-CATALOG-ADMISSION.md' },
    { title: '[C2] Catalog check', status: 'done', body: 'Spec: docs/SPEC-CATALOG-ADMISSION.md\n' },
  ]
  const p = specProgress(cohBatches, tasks, 'docs/SPEC-COHERENCE.md')
  assert.equal(p.byId.size, 0)
  assert.equal(p.allFiled, false)
  assert.equal(p.allDone, false)

  const matching = [
    ...tasks,
    { title: '[C1] Coherence step 1', status: 'done', spec: 'docs/SPEC-COHERENCE.md' },
  ]
  const p2 = specProgress(cohBatches, matching, 'docs/SPEC-COHERENCE.md')
  assert.equal(p2.byId.size, 1)
  assert.equal(p2.byId.get('C1')?.title, '[C1] Coherence step 1')
  assert.equal(p2.allFiled, false)
})

test('無印タスクは specMtime 以降のものだけ拾う（過去の [C1] が新規 SPEC を完了にしない・D91）', () => {
  const specMtime = 1_700_000_000_000
  const stale = { title: '[C1] Legacy unmarked', status: 'done', createdAt: specMtime - 10 * 60_000 }
  const fresh = { title: '[C1] New unmarked', status: 'done', createdAt: specMtime - 1000 }

  // 猶予（5000ms）より前の無印は対象外 → 未起票
  const old = specProgress([{ id: 'C1' }], [stale], 'docs/SPEC-NEW.md', { specMtime })
  assert.equal(old.byId.size, 0)
  assert.equal(old.allFiled, false)

  // 猶予以内（mtime - 1000ms）なら対象（ワーカーが SPEC 直後に起票するケース）
  const recent = specProgress([{ id: 'C1' }], [fresh], 'docs/SPEC-NEW.md', { specMtime })
  assert.equal(recent.byId.get('C1')?.title, '[C1] New unmarked')
  assert.equal(recent.allDone, true)

  // ちょうど猶予の境界（mtime - 5000ms）は許可（>= 判定）
  const edge = specProgress(
    [{ id: 'C1' }],
    [{ title: '[C1] Edge', status: 'done', startedAt: specMtime - SPEC_MTIME_SLACK_MS }],
    'docs/SPEC-NEW.md',
    { specMtime },
  )
  assert.equal(edge.allFiled, true)

  // specMtime を渡さなければ従来どおり（後方互換）
  const noGuard = specProgress([{ id: 'C1' }], [stale], 'docs/SPEC-NEW.md')
  assert.equal(noGuard.allFiled, true)
})

test('runTaskIds（pipeline-runs.json）との一致が最優先（Spec 行・無印より強い）', () => {
  const specMtime = 1_700_000_000_000
  const tasks = [
    // 別 SPEC 表記だが、ラン記録に載っているので C1 として拾う
    { id: 't_run', title: '[C1] Filed by the launcher', status: 'done', spec: 'docs/SPEC-OTHER.md', createdAt: specMtime - 60_000 },
    // Spec 行一致（第 2 優先）
    { id: 't_spec', title: '[C2] Spec matched', status: 'done', spec: 'docs/SPEC-NEW.md' },
    // 無印・古い（時刻ガードで落ちるはず）
    { id: 't_old', title: '[C3] Legacy', status: 'done', createdAt: specMtime - 600_000 },
  ]
  const batches3 = [{ id: 'C1' }, { id: 'C2' }, { id: 'C3' }]
  const p = specProgress(batches3, tasks, 'docs/SPEC-NEW.md', { specMtime, runTaskIds: ['t_run'] })
  assert.equal(p.byId.get('C1')?.title, '[C1] Filed by the launcher')
  assert.equal(p.byId.get('C2')?.title, '[C2] Spec matched')
  assert.equal(p.byId.has('C3'), false, '古い無印は時刻ガードで落ちる')
  assert.equal(p.allFiled, false)
  assert.equal(p.allDone, false)

  // runTaskIds が同じバッチに複数あるときは done ＞ オープン ＞ archived
  const dup = specProgress(
    [{ id: 'C1' }],
    [
      { id: 't_a', title: '[C1] archived', status: 'archived', spec: 'docs/SPEC-OTHER.md' },
      { id: 't_b', title: '[C1] running', status: 'running', spec: 'docs/SPEC-OTHER.md' },
    ],
    'docs/SPEC-NEW.md',
    { runTaskIds: ['t_a', 't_b'] },
  )
  assert.equal(dup.byId.get('C1')?.status, 'running')
  assert.equal(dup.allDone, false)
})

test('タイトルに ID が無くても本文の Batch: ヘッダで紐づく（D91 ③）', () => {
  const t = {
    title: 'Renamed by a human',
    status: 'done',
    spec: 'docs/SPEC-NEW.md',
    body: 'Spec: docs/SPEC-NEW.md\nBatch: RG-1 — first batch\n',
  }
  const p = specProgress([{ id: 'RG-1' }], [t], 'docs/SPEC-NEW.md')
  assert.equal(p.byId.get('RG-1')?.title, 'Renamed by a human')
  assert.equal(p.allDone, true)
})
