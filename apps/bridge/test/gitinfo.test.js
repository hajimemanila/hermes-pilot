import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createGitInfo } from '../src/gitinfo.js'

/** ひらがな・カタカナ・漢字・全角形（`reason` は英語のみ・SPEC-EN-ZERO-LEAK D74）。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60]/

/** 一時的な git リポジトリと history.jsonl を作る。 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-git-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  const run = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 't@example.com')
  run('config', 'user.name', 'T')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n')
  run('add', '-A')
  run('commit', '-q', '-m', 'first')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n')
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n')
  run('add', '-A')
  run('commit', '-q', '-m', 'feat: add lines')
  const head = run('rev-parse', '--short', 'HEAD').trim()

  const history = path.join(root, 'history.jsonl')
  const rows = [
    { event: 'start', task_id: 't_1' },
    {
      event: 'done',
      task_id: 't_1',
      metadata: {
        git: { repo, branch: 'main', head, dirty: false, changed_count: 0 },
        session_anchor: { chat_id: '123', message_id: '456', session_id: 'sess-1' },
        changed_files: ['a.txt', 'b.txt'],
      },
    },
  ]
  fs.writeFileSync(history, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return { root, repo, head, history }
}

test('履歴から head/branch/サマリを引ける', async () => {
  const { history } = fixture()
  const gi = createGitInfo({ home: '/nonexistent', sopHistory: history })
  const info = await gi.forTask('t_1')
  assert.equal(info.head.length >= 7, true)
  assert.equal(info.branch, 'main')
  assert.equal(info.subject, 'feat: add lines')
  assert.equal(info.dirty, false)
})

test('履歴に無いタスクは null（推測で埋めない）', async () => {
  const { history } = fixture()
  const gi = createGitInfo({ home: '/nonexistent', sopHistory: history })
  assert.equal(await gi.forTask('t_unknown'), null)
})

test('diffSummary はファイル毎の +add −del と合計を返す', async () => {
  const { history } = fixture()
  const gi = createGitInfo({ home: '/nonexistent', sopHistory: history })
  const d = await gi.diffSummary('t_1')
  assert.equal(d.ok, true)
  assert.equal(d.subject, 'feat: add lines')
  const a = d.files.find((f) => f.path === 'a.txt')
  const b = d.files.find((f) => f.path === 'b.txt')
  assert.equal(a.add, 2)
  assert.equal(a.del, 0)
  assert.equal(b.add, 1)
  assert.equal(d.total.add, 3)
  assert.equal(d.total.del, 0)
})

test('diffSummary は git 記録が無いタスクで理由を返す', async () => {
  const { history } = fixture()
  const gi = createGitInfo({ home: '/nonexistent', sopHistory: history })
  const d = await gi.diffSummary('t_none')
  assert.equal(d.ok, false)
  assert.match(d.reason, /no Git record/i)
  assert.equal(CJK.test(d.reason), false, `reason が英語になっていません: ${d.reason}`)
})

test('filePatch はコミットに含まれるファイルだけ返す', async () => {
  const { history } = fixture()
  const gi = createGitInfo({ home: '/nonexistent', sopHistory: history })
  const ok = await gi.filePatch('t_1', 'b.txt')
  assert.equal(ok.ok, true)
  assert.match(ok.text, /\+new/)
  const ng = await gi.filePatch('t_1', 'package.json')
  assert.equal(ng.ok, false)
  assert.match(ng.reason, /not part of this commit/i)
  assert.equal(CJK.test(ng.reason), false, `reason が英語になっていません: ${ng.reason}`)
})

test('filePatch はパストラバーサルを拒否する', async () => {
  const { history } = fixture()
  const gi = createGitInfo({ home: '/nonexistent', sopHistory: history })
  for (const bad of ['../../etc/passwd', '/etc/passwd', '--upload-pack=/bin/sh']) {
    const r = await gi.filePatch('t_1', bad)
    assert.equal(r.ok, false, bad)
  }
})

test('Kanban ネイティブ解決: branch / grep=<taskId> / 明示 SHA で解決し、無関係 HEAD は推測しない', async () => {
  const { root, repo } = fixture()
  try {
    const run = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    // t_branch 用ブランチにコミットを作る
    run('checkout', '-q', '-b', 'feat/t-branch')
    fs.writeFileSync(path.join(repo, 'c.txt'), 'branch-work\n')
    run('add', '-A')
    run('commit', '-q', '-m', 'feat: branch commit')
    const branchHead = run('rev-parse', '--short', 'HEAD').trim()

    // t_grep123 用コミットをメッセージに ID 付きで作る
    run('checkout', '-q', 'main')
    fs.writeFileSync(path.join(repo, 'd.txt'), 'grep-work\n')
    run('add', '-A')
    run('commit', '-q', '-m', 'fix(t_grep123): resolve by task id grep')
    const grepHead = run('rev-parse', '--short', 'HEAD').trim()

    // main 上に別コミットを作り result 中の明示 SHA で参照できるようにする
    fs.writeFileSync(path.join(repo, 'e.txt'), 'sha-work\n')
    run('add', '-A')
    run('commit', '-q', '-m', 'chore: explicit sha commit')
    const shaHead = run('rev-parse', '--short', 'HEAD').trim()

    const tasks = {
      t_branch: { id: 't_branch', status: 'done', branch: 'feat/t-branch', workspace: repo },
      t_grep123: { id: 't_grep123', status: 'done', branch: '', result: 'done', workspace: '' },
      t_sha: { id: 't_sha', status: 'done', branch: '', result: `Committed at commit ${shaHead}`, workspace: repo },
      t_miss: { id: 't_miss', status: 'done', branch: '', result: 'unrelated text without commit', workspace: repo },
    }
    const gi = createGitInfo(
      { home: root, sopHistory: path.join(root, 'missing-history.jsonl') },
      {
        kanban: {
          boards: () => [{ slug: 'my-app', archived: false, workdir: repo }],
          task: (_board, id) => {
            if (!tasks[id]) throw new Error('TASK_NOT_FOUND')
            return tasks[id]
          },
        },
      },
    )

    const bInfo = await gi.forTask('t_branch', { board: 'my-app' })
    assert.equal(bInfo.head, branchHead)
    assert.equal(bInfo.branch, 'feat/t-branch')

    const gInfo = await gi.forTask('t_grep123')
    assert.equal(gInfo.head, grepHead)
    assert.match(gInfo.subject, /t_grep123/)

    const sInfo = await gi.forTask('t_sha', { board: 'my-app' })
    assert.equal(sInfo.head, shaHead)
    const sDiff = await gi.diffSummary('t_sha', { board: 'my-app' })
    assert.equal(sDiff.ok, true)
    assert.ok(sDiff.files.some((f) => f.path === 'e.txt'))

    // 無関係なタスクには HEAD を当てない
    assert.equal(await gi.forTask('t_miss', { board: 'my-app' }), null)
    const missDiff = await gi.diffSummary('t_miss', { board: 'my-app' })
    assert.equal(missDiff.ok, false)
    assert.equal(missDiff.code, 'NO_GIT_RECORD')
    assert.equal(CJK.test(missDiff.reason), false)
    assert.equal(/kanban-sop/i.test(missDiff.reason), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('履歴の dirty:true は実ツリーがクリーン化または別 HEAD へ進んだら自動で落ちる', async () => {
  const { root, repo, head } = fixture()
  try {
    const run = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    const history = path.join(root, 'dirty-history.jsonl')
    const writeHist = (rows) =>
      fs.writeFileSync(history, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

    writeHist([
      {
        event: 'done',
        task_id: 't_dirty_head',
        metadata: { git: { repo, branch: 'main', head, dirty: true, changed_count: 3 } },
      },
      {
        event: 'done',
        task_id: 't_dirty_nohead',
        metadata: { git: { repo, branch: 'main', head: '', dirty: true, changed_count: 2 } },
      },
    ])

    // 1) 現 HEAD 上で実際に未コミット変更がある間だけ dirty: true
    fs.writeFileSync(path.join(repo, 'wip.txt'), 'uncommitted\n')
    const giDirty = createGitInfo({ home: root, sopHistory: history })
    const d1 = await giDirty.forTask('t_dirty_head')
    assert.equal(d1.dirty, true)
    assert.equal(d1.changedCount, 3)
    assert.equal((await giDirty.diffSummary('t_dirty_head')).dirty, true)
    assert.equal((await giDirty.forTask('t_dirty_nohead')).dirty, true)

    // 2) コミットしてクリーンになり HEAD が進むと dirty / changedCount ともに落ちる
    run('add', '-A')
    run('commit', '-q', '-m', 'chore: commit wip')
    const giClean = createGitInfo({ home: root, sopHistory: history })
    const d2 = await giClean.forTask('t_dirty_head')
    assert.equal(d2.dirty, false)
    assert.equal(d2.changedCount, 0)
    assert.equal((await giClean.diffSummary('t_dirty_head')).dirty, false)
    assert.equal((await giClean.forTask('t_dirty_nohead')).dirty, false)

    // 3) 別コミット（新 HEAD）上で新たに未コミットファイルができても旧コミットのタスクは dirty に戻らない
    fs.writeFileSync(path.join(repo, 'later-wip.txt'), 'later work\n')
    const giLater = createGitInfo({ home: root, sopHistory: history })
    const d3 = await giLater.forTask('t_dirty_head')
    assert.equal(d3.dirty, false)
    assert.equal(d3.changedCount, 0)
    assert.equal((await giLater.diffSummary('t_dirty_head')).dirty, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
