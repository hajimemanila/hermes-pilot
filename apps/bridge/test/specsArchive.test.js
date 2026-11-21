/**
 * SPEC スプロール規約（SPEC-COHERENCE §3.3 / D84・COH-4）のリポジトリ検証。
 *
 * `coherence.js` の Layer 1 はアクティブ SPEC が `specSprawlLimit`（既定 6）を超えると
 * `spec-sprawl` を出す。完了済みの歴史 SPEC は**ファイルパスを動かさず**、先頭 40 行の
 * メタデータ部に `- **Status**: archived` を宣言して、既定表示（`/api/specs` は
 * アクティブのみ・アーカイブは `archivedSpecs` の別枠）から外す。
 *
 * ここでは `specs.js` の判定を経由せず、生の Markdown を同じ規則で読んでリポジトリの
 * 状態そのものを固定する（アーカイブ基盤の実装状況に依存しない回帰ガード）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/** `specs.js` の `SPEC_ARCHIVED_RE` / `coherence.js` の `ARCHIVED_RE` と同じ規則。 */
const ARCHIVED_RE =
  /^\s*[-*]?\s*\*\*\s*(?:Status|状態)\s*\*\*\s*[:：]\s*[`]?\s*(?:archived|アーカイブ)/i

/** SPEC スプロールの上限（`coherence.js` の `UNIVERSAL_DEFAULTS.specSprawlLimit` と同値）。 */
const SPEC_SPRAWL_LIMIT = 6

/** COH-4 でアーカイブした完了済み歴史 SPEC（パスは動かしていない＝リンク互換維持）。 */
const HISTORICAL_SPECS = [
  'SPEC-PILOT-V2.md',
  'SPEC-PILOT-V3.md',
  'SPEC-PILOT-V4.md',
  'SPEC-PILOT-V5.md',
  'SPEC-PILOT-V6.md',
  'SPEC-PILOT-V7.md',
  'SPEC-PILOT-V8.md',
  'SPEC-PILOT-V9.md',
  'SPEC-PILOT-V10.md',
  'SPEC-PILOT-V11.md',
  'SPEC-PUBLIC-PLUGIN.md',
  'SPEC-CATALOG-ADMISSION.md',
  'SPEC-ver-0-2-1.md',
  'SPEC-SHARE280.md',
  'SPEC-REPO-PICKER.md',
  'SPEC-PROFILE-CHAT.md',
  'SPEC-i18n-gen.md',
  'SPEC-i18n-resp.md',
  'SPEC-UI-POLISH-V22.md',
  'SPEC-ROLE-DELEGATION-ROUTING.md',
  'SPEC-EN-ZERO-LEAK.md',
  'SPEC-enter-enter-discuss-next-ste.md',
]

/** 実リポジトリの `docs/`（このテストは `apps/bridge/test/` から走る）。 */
const DOCS = path.resolve(import.meta.dirname, '../../../docs')

/**
 * 先頭 40 行にアーカイブ宣言があるか。本文の奥の言及（規約説明など）は拾わない。
 * @param {string} file SPEC の絶対パス
 * @returns {boolean} アーカイブ済みか
 */
function declaresArchived(file) {
  const head = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 40)
  return head.some((line) => ARCHIVED_RE.test(line))
}

test('完了済み歴史 SPEC は先頭 40 行で Status: archived を宣言する', () => {
  if (!fs.existsSync(DOCS)) return // 仕様書を含まない配布物ではスキップ
  const missing = HISTORICAL_SPECS.filter((name) => {
    const file = path.join(DOCS, name)
    return fs.existsSync(file) && !declaresArchived(file)
  })
  assert.deepEqual(missing, [], `${missing.join(', ')} に \`- **Status**: archived\` が無い`)
})

test('アクティブ SPEC は specSprawlLimit 以下（全バッチ完了後のアーカイブ化を妨げない）', () => {
  if (!fs.existsSync(DOCS)) return
  const names = fs.readdirSync(DOCS).filter((n) => /^SPEC-.*\.md$/.test(n))
  const active = names.filter((n) => !declaresArchived(path.join(DOCS, n)))
  assert.ok(
    active.length <= SPEC_SPRAWL_LIMIT,
    `アクティブ SPEC が ${active.length} 件（上限 ${SPEC_SPRAWL_LIMIT}）: ${active.join(', ')}`,
  )
})
