/**
 * ホームディレクトリ表記（`~`）の展開。
 *
 * このモジュールが **唯一の定義**（SPEC-COHERENCE-SWEEP-3 §3.5 / CSW3-8）。以前は
 * `repos.js`・`review/boards.js`・`gitinfo.js` に同じ名前の実装が 3 つあった。
 *
 * 挙動は `review/boards.js` の版を正とする:
 * - `~` → ホームそのもの、`~/x` → `<home>/x`
 * - **相対パスはそのまま返す**（ホーム基準で絶対化したい呼び出し側が明示的に行う）
 *
 * 絶対化まで必要な場所（`repos.js` の `normalizePath` やスキャン対象）は
 * `path.resolve(home, expandHome(raw, home))` と書く。解決位置を隠さないため、
 * この関数は絶対化しない。
 */
import path from 'node:path'
import os from 'node:os'

/**
 * `~` / `~/` をホームディレクトリへ展開する。
 *
 * @param {string} p パス
 * @param {string} [home] ホームディレクトリ（既定は `os.homedir()`）
 * @returns {string} 展開後のパス（`~` 以外の相対パスはそのまま）
 */
export function expandHome(p, home = os.homedir()) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  if (s === '~') return home
  if (s.startsWith('~/')) return path.join(home, s.slice(2))
  return s
}
