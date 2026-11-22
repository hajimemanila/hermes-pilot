/**
 * `apps/bridge/src/lib/cli.js`（D102）の契約テスト。
 *
 * 外部 CLI の戻り値は 1 形だけ: `{ ok, code, stdout, stderr, timedOut, bin, args }`。
 * ここでは本物の子プロセスを 1 回ずつ走らせて、成功・失敗・タイムアウト・spawn 失敗を固定する。
 * 旧形（`{code,out}` / `{code,stdout,stderr}` / `string|null`）は `outcomeOf()` が吸収する。
 *
 * 併せて `check-coherence` の `cli-owner`（`execFile(` は `lib/cli.js` だけ）を検査する。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { outcomeOf, outputOf, run, runHermes } from '../src/lib/cli.js'
import { buildAugmentedPath } from '../src/capabilities.js'
import { cliOwnerProblems, walkCode } from '../../../scripts/check-coherence.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** 一時スクリプトを書いて絶対パスを返す（タイムアウト・出力検査用）。 */
function script(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cli-'))
  const file = path.join(dir, 'probe.mjs')
  fs.writeFileSync(file, body)
  return file
}

test('run(): 成功時は ok/code 0 で stdout と stderr を分けて返す', async () => {
  const file = script("process.stdout.write('out-text')\nprocess.stderr.write('err-text')\n")
  const res = await run(process.execPath, [file])
  assert.equal(res.ok, true)
  assert.equal(res.code, 0)
  assert.equal(res.timedOut, false)
  assert.equal(res.stdout, 'out-text')
  assert.equal(res.stderr, 'err-text')
  assert.deepEqual(res.args, [file])
  assert.equal(res.bin, process.execPath)
  assert.deepEqual(Object.keys(res).sort(), ['args', 'bin', 'code', 'ok', 'stderr', 'stdout', 'timedOut'])
})

test('run(): タイムアウトは timedOut: true かつ code: null（exit 1 と区別する）', async () => {
  const file = script('setTimeout(() => {}, 5000)\n')
  const res = await run(process.execPath, [file], { timeoutMs: 150 })
  assert.equal(res.timedOut, true)
  assert.equal(res.code, null)
  assert.equal(res.ok, false)
})

test('run(): 非ゼロ終了は code が数値で ok が false', async () => {
  const file = script('process.exit(3)\n')
  const res = await run(process.execPath, [file])
  assert.equal(res.ok, false)
  assert.equal(res.code, 3)
  assert.equal(res.timedOut, false)
})

test('run(): spawn 失敗は code: null / ok: false（stderr に理由が残る）', async () => {
  const res = await run('/nonexistent/hm-cli-probe', [])
  assert.equal(res.ok, false)
  assert.equal(res.code, null)
  assert.equal(res.timedOut, false)
  assert.match(res.stderr, /hm-cli-probe/)
})

test('runHermes(): opts.bin を尊重し、PATH は buildAugmentedPath() で組み直す', async () => {
  const file = script('process.stdout.write(process.env.PATH ?? "")\n')
  const echoed = await runHermes([file], { bin: process.execPath })
  assert.equal(echoed.ok, true)
  assert.equal(echoed.stdout, buildAugmentedPath())
  assert.equal(echoed.bin, process.execPath)
  // hermes CLI でも同じ境界を使う（`kanban` を含む引数でも解決は 1 か所）。
  const missing = await runHermes(['kanban', '--board', 'x', 'list'], { bin: '/nonexistent/hermes-probe' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, null)
  assert.deepEqual(missing.args.slice(0, 3), ['kanban', '--board', 'x'])
})

test('outcomeOf(): 旧 5 形をすべて統一形へ正規化する', () => {
  const legacyOut = outcomeOf({ code: 0, out: 'created t_1' })
  assert.deepEqual(
    { ok: legacyOut.ok, code: legacyOut.code, stdout: legacyOut.stdout, stderr: legacyOut.stderr, timedOut: legacyOut.timedOut },
    { ok: true, code: 0, stdout: 'created t_1', stderr: '', timedOut: false },
  )

  const legacyStreams = outcomeOf({ code: 1, stdout: 'a', stderr: 'b', bin: 'hermes', args: ['x'] })
  assert.equal(legacyStreams.ok, false)
  assert.equal(legacyStreams.stdout, 'a')
  assert.equal(legacyStreams.stderr, 'b')
  assert.equal(legacyStreams.bin, 'hermes')
  assert.deepEqual(legacyStreams.args, ['x'])

  assert.deepEqual(
    { ok: outcomeOf('git-sha').ok, code: outcomeOf('git-sha').code, stdout: outcomeOf('git-sha').stdout },
    { ok: true, code: 0, stdout: 'git-sha' },
  )

  const failed = outcomeOf(null)
  assert.equal(failed.ok, false)
  assert.equal(failed.code, null)

  // 新しい形はそのまま通る（タイムアウトは ok false を保つ）。
  const timedOut = outcomeOf({ ok: false, code: null, stdout: '', stderr: '', timedOut: true })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.timedOut, true)
})

test('outputOf(): 旧 out（stdout+stderr 連結）を呼び出し側で作れる', () => {
  assert.equal(outputOf({ stdout: 'a', stderr: 'b' }), 'ab')
  assert.equal(outputOf({ stdout: 'a', stderr: '' }), 'a')
  assert.equal(outputOf(null), '')
})

test('cli-owner: execFile( は apps/bridge/src/lib/cli.js だけ（対象外は理由つきで許可）', () => {
  const hits = []
  for (const file of walkCode(ROOT, 'apps/bridge/src')) {
    const raw = fs.readFileSync(file.abs, 'utf8')
    for (const problem of cliOwnerProblems(file.rel, raw)) hits.push(`${file.rel}:${problem.line}`)
  }
  assert.deepEqual(hits, [])

  // 許可リストの判定（対象外はコメントで理由を書く）。
  assert.equal(cliOwnerProblems('apps/bridge/src/coherence.js', "execFile(process.execPath, ['x'], {})").length, 0)
  assert.equal(cliOwnerProblems('apps/bridge/src/server/helpers.js', 'execFile(bin, [])').length, 0)
  assert.equal(cliOwnerProblems('apps/bridge/src/kanban.js', "execFile(bin, ['kanban'], {})").length, 1)
  // コメント行は数えない（doc コメントの `execFile(` を違反にしない）。
  assert.equal(cliOwnerProblems('apps/bridge/src/kanban.js', '// execFile(bin) is not allowed here\n').length, 0)
})
