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
