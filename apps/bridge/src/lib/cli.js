import { execFile } from 'node:child_process'
import { buildAugmentedPath, resolveHermesBin } from '../capabilities.js'

/**
 * 外部 CLI の唯一の境界（D102）。
 *
 * 戻り値は常に 7 つの同じキー: `{ ok, code, stdout, stderr, timedOut, bin, args }`。
 * - `code`: 成功 `0` / `err.code` が数値ならその値 / タイムアウト・spawn 失敗は `null`
 * - `timedOut`: `Boolean(err?.killed)`
 * - `ok`: `code === 0 && !timedOut`
 * - `stdout` / `stderr` は常に文字列（`''` を含む）
 *
 * `out`（stdout+stderr 連結）は返さない。連結が要る呼び出し側は `outputOf()` で作る。
 */

const DEFAULTS = Object.freeze({ timeoutMs: 15_000, maxBuffer: 1_000_000 })

/**
 * 戻り値を 1 つの形へ揃える。
 *
 * @param {{code?: number|null, stdout?: string, stderr?: string, timedOut?: boolean, bin?: string, args?: string[]}} [parts] 部品
 * @returns {{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean, bin: string, args: string[]}} 統一形
 */
function shape(parts = {}) {
  const raw = parts.code
  const code = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  const timedOut = Boolean(parts.timedOut)
  return {
    ok: code === 0 && !timedOut,
    code,
    stdout: String(parts.stdout ?? ''),
    stderr: String(parts.stderr ?? ''),
    timedOut,
    bin: String(parts.bin ?? ''),
    args: Array.isArray(parts.args) ? parts.args : [],
  }
}

/**
 * 外部 CLI を 1 回実行する（`execFile` を直接使ってよい唯一の場所）。
 *
 * @param {string} bin 実行ファイル
 * @param {string[]} args 引数
 * @param {{timeoutMs?: number, maxBuffer?: number, cwd?: string, env?: object}} [opts] 実行条件
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean, bin: string, args: string[]}>} 結果
 */
export function run(bin, args, opts = {}) {
  const argv = Array.isArray(args) ? args.map((arg) => String(arg)) : []
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULTS.timeoutMs
  const maxBuffer = Number.isFinite(opts.maxBuffer) ? opts.maxBuffer : DEFAULTS.maxBuffer
  const env = { ...process.env, ...(opts.env ?? {}) }
  const execOpts = { timeout: timeoutMs, maxBuffer, env, ...(opts.cwd ? { cwd: String(opts.cwd) } : {}) }
  return new Promise((resolve) => {
    try {
      execFile(String(bin), argv, execOpts, (err, stdout, stderr) => {
        const failure = err ? String(err.message ?? '') : ''
        resolve(
          shape({
            code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
            stdout,
            // spawn 失敗（ENOENT など）は stderr が空なので、message を失敗理由として残す。
            stderr: failure && !stderr ? failure : stderr,
            timedOut: Boolean(err?.killed),
            bin,
            args: argv,
          }),
        )
      })
    } catch (error) {
      resolve(shape({ code: null, stderr: String(error?.message ?? error), bin, args: argv }))
    }
  })
}

/**
 * `hermes` CLI を実行する（`resolveHermesBin()` と `buildAugmentedPath()` を必ず通す）。
 *
 * @param {string[]} args 引数
 * @param {{bin?: string, timeoutMs?: number, maxBuffer?: number, cwd?: string, env?: object}} [opts] 実行条件
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean, bin: string, args: string[]}>} 結果
 */
export function runHermes(args, opts = {}) {
  const bin = opts.bin || resolveHermesBin()
  const env = { ...(opts.env ?? {}), PATH: buildAugmentedPath() }
  return run(bin, args, { ...opts, bin: undefined, env })
}

/**
 * 旧 5 形（`{code,out}` / `{code,stdout,stderr}` / `{code,stdout,stderr,bin,args}` / `string|null` /
 * 新しい統一形）を統一形へ正規化する。**注入シーム専用**: テストが返す古い形を吸収する。
 *
 * @param {unknown} res 旧形の結果
 * @returns {{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean, bin: string, args: string[]}} 統一形
 */
export function outcomeOf(res) {
  if (res == null) return shape({ code: null })
  if (typeof res === 'string') return shape({ code: 0, stdout: res })
  if (typeof res !== 'object') return shape({ code: null, stderr: String(res) })
  const out = res
  const stdout = out.stdout !== undefined ? out.stdout : (out.out ?? '')
  const raw = out.code
  let code = null
  if (typeof raw === 'number' && Number.isFinite(raw)) code = raw
  else if (raw == null && out.ok === true) code = 0
  return shape({
    code,
    stdout,
    stderr: out.stderr ?? '',
    timedOut: Boolean(out.timedOut ?? out.killed),
    bin: out.bin ?? '',
    args: out.args,
  })
}

/**
 * 旧 `out`（stdout+stderr の連結）を作る。新しい戻り値に `out` は含めないので、
 * 画面・レスポンス用の 1 行が要る呼び出し側だけがこれを使う。
 *
 * @param {{stdout?: string, stderr?: string}|null} res 統一形の結果
 * @returns {string} 連結した出力
 */
export function outputOf(res) {
  if (!res) return ''
  return `${res.stdout ?? ''}${res.stderr ?? ''}`.trim()
}
