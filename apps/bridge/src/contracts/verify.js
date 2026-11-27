/**
 * 検証契約の抽象化（SPEC-COHERENCE §3 COH-2 / D85）。
 *
 * 背景: プラグイン（`hermes-pilot`）は**任意のリポジトリ**を扱うのに、行動契約・
 * パイプラインの提案文へ `npm run verify` / `npm run deploy` / `390×844` を直書きしていた。
 * これは hermes-mobile-pwa の流儀を他リポジトリへ押し付ける（例: Python のリポジトリに
 * `npm run verify` を提案する）ため、**対象リポジトリ側の宣言へ委ねる**表現に一般化する。
 *
 * 委ね先の優先順（`VERIFY_SOURCE_HINTS`）:
 * 1. 対象リポジトリのプロファイルメモリ（プロファイルごとの検証コマンド）
 * 2. `AGENTS.md` / `SOUL.md` の作業規約
 * 3. SPEC の **Verify** 欄（バッチごとの受入コマンド）
 *
 * ここには**特定コマンド名・特定画面サイズを書かない**。書いた瞬間に別リポジトリで嘘になる。
 * 強制は `apps/bridge/test/specs.test.js` と `apps/bridge/test/pipelineOptimizer.test.js`、
 * `apps/bridge/test/pipelineWatcher.test.js`（`npm run verify` / `390×844` の再流入を検出）。
 */

/** 委ね先の説明（英文の契約文に埋め込む括弧書き）。 */
const VERIFY_SOURCE_HINTS = 'its profile memory, AGENTS.md, or the SPEC **Verify** section'

/** 検証コマンドの呼称（英文。文の主語として使える名詞句）。 */
export const VERIFY_COMMAND_NOUN = 'the verification command the target repository declares'

/** 検証コマンド＋委ね先（英文。1 文に埋め込める形）。 */
export const VERIFY_CONTRACT = `${VERIFY_COMMAND_NOUN} (${VERIFY_SOURCE_HINTS})`

/** 画面サイズの呼称（英文）。`visual-gate` の実画面確認に使う。 */
export const SCREEN_CHECK_CONTRACT =
  'the screen sizes the target repository declares (its SPEC **Verify** section or design rules)'

/** 検証コマンドの呼称（和文。レポート・提案文の JA 側に使う）。 */
const VERIFY_COMMAND_NOUN_JA = '対象リポジトリが宣言する検証コマンド'

/** 検証コマンド＋委ね先（和文）。 */
export const VERIFY_CONTRACT_JA = `${VERIFY_COMMAND_NOUN_JA}（SPEC の Verify 欄・プロファイルメモリ・AGENTS.md）`

/**
 * 抽象化が崩れていないかを 1 箇所で判定する（テストと将来の `check:coherence` 用）。
 *
 * @param {string} text 検査する文面（契約ブロック・提案文など）
 * @returns {{ok: boolean, hits: string[]}} 決め打ちが見つかったら `ok: false`
 */
export function findHardcodedVerification(text) {
  const src = String(text ?? '')
  const hits = []
  if (/npm run verify/.test(src)) hits.push('npm run verify')
  if (/npm run deploy/.test(src)) hits.push('npm run deploy')
  if (/390\s*[x×]\s*844/.test(src)) hits.push('390x844')
  if (/820\s*[x×]\s*1180/.test(src)) hits.push('820x1180')
  return { ok: hits.length === 0, hits }
}
