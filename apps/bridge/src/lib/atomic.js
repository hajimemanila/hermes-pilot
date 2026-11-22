/**
 * 状態ファイルの書き込みを 1 か所に集める（D101 / SPEC-COHERENCE-AUDIT-2 §3.1）。
 *
 * このモジュールの 3 関数だけが `fs.writeFileSync` を呼ぶ（`check:coherence` の
 * `write-owner` が固定する）。どの関数も `<file>.tmp-<pid>-<連番>` に書いてから
 * **同じディレクトリ内**で `renameSync` するので、途中で落ちても既存のファイルは
 * 半端な内容にならない（cross-device の `EXDEV` も起きない）。
 *
 * - `writeJsonAtomic(file, value, opts)` … JSON 1 枚（`pretty` / `newline` で整形を保つ）
 * - `writeFileAtomic(file, data, opts)` … 文字列・Buffer 1 枚
 * - `writePairAtomic(pairs, opts)` … 正本が先。途中で落ちたら `failedAt` を返す
 *
 * `createAtomic({ fs })` はテストが偽 fs（`renameSync` で throw）を差し込むための入口。
 */

import fs from 'node:fs'
import path from 'node:path'

/** プロセス内で一意な tmp 名の連番。 */
let sequence = 0

/** `<file>.tmp-<pid>-<連番>`（同じディレクトリに置くので rename が原子的になる）。 */
function nextTmp(file) {
  sequence += 1
  return `${file}.tmp-${process.pid}-${sequence}`
}

/**
 * 偽 fs を差し込める書き込み器を作る。
 *
 * @param {object} [overrides] `fs` の一部を差し替える（テスト専用）
 * @returns {{writeFileAtomic: Function, writeJsonAtomic: Function, writePairAtomic: Function}} 書き込み器
 */
export function createAtomic(overrides = {}) {
  const io = { ...fs, ...overrides }

  /**
   * 文字列・Buffer を 1 枚アトミックに書く。親ディレクトリは必要なら作る。失敗は throw。
   *
   * @param {string} file 書き込み先
   * @param {string|Buffer} data 中身
   * @param {{mode?: number, encoding?: BufferEncoding|string}} [opts] 権限と文字コード
   * @returns {void}
   */
  function writeFileAtomic(file, data, { mode = 0o600, encoding = 'utf8' } = {}) {
    io.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = nextTmp(file)
    try {
      io.writeFileSync(tmp, data, { encoding, mode })
      io.renameSync(tmp, file)
    } catch (error) {
      try {
        io.unlinkSync(tmp)
      } catch {
        /* tmp が残っていなければ noop */
      }
      throw error
    }
  }

  /**
   * JSON をアトミックに書く（整形は呼び出し側の現行値に合わせる）。
   *
   * @param {string} file 書き込み先
   * @param {unknown} value 値
   * @param {{mode?: number, pretty?: number, newline?: boolean}} [opts] 権限・インデント・末尾改行
   * @returns {void}
   */
  function writeJsonAtomic(file, value, { mode = 0o600, pretty = 2, newline = false } = {}) {
    const body = JSON.stringify(value, null, pretty ?? 0)
    writeFileAtomic(file, newline ? `${body}\n` : body, { mode })
  }

  /**
   * 複数ファイルを**正本が先**の順に書く。途中で落ちたらそこで止め、`failedAt` を返す。
   * すでに書けたファイルは確定済み（それぞれが原子的なので壊れていない）。
   *
   * @param {Array<[string, unknown, object?]>} pairs `[file, data, opts]` の配列
   * @param {{mode?: number}} [defaults] 既定の権限
   * @returns {{written: string[], failedAt: number|null, error: Error|null}} 結果
   */
  function writePairAtomic(pairs, { mode = 0o600 } = {}) {
    const written = []
    for (let index = 0; index < pairs.length; index += 1) {
      const [file, data, opts = {}] = pairs[index]
      try {
        if (opts.json) {
          writeJsonAtomic(file, data, {
            mode: opts.mode ?? mode,
            pretty: opts.pretty ?? 2,
            newline: opts.newline ?? false,
          })
        } else {
          writeFileAtomic(file, data, { mode: opts.mode ?? mode, encoding: opts.encoding ?? 'utf8' })
        }
        written.push(file)
      } catch (error) {
        return { written, failedAt: index, error }
      }
    }
    return { written, failedAt: null, error: null }
  }

  return { writeFileAtomic, writeJsonAtomic, writePairAtomic }
}

const defaultWriter = createAtomic()

export const writeFileAtomic = defaultWriter.writeFileAtomic
export const writeJsonAtomic = defaultWriter.writeJsonAtomic
export const writePairAtomic = defaultWriter.writePairAtomic
