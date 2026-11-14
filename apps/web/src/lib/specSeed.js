/**
 * `🎙️ Spec Seed` の純粋ロジック（SPEC V5 §3.3 ① / D26①）。
 *
 * 画面（`features/SpecSeedSheet.jsx`）から切り離しておき、DOM 無しで単体テストする。
 * 文言は i18n 辞書（`seed.*`）が持ち、ここには英語の ASCII ロジックだけを置く
 * （`noHardcodedJapanese.test.js` は `src/` を丸ごと走査するため）。
 */

/** 種の最大文字数（ブリッジの `SEED_MAX` と一致させる）。 */
export const SEED_MAX = 4000

/** テンプレートチップの ID（ラベル・本文は i18n の `seed.tpl.<id>` / `seed.tpl.<id>Text`）。 */
export const TEMPLATE_IDS = ['feature', 'ux', 'bug']

/**
 * Web Speech API の言語コード（UI 言語に追従）。
 * @param {string} lang `'ja'|'en'`
 * @returns {string} BCP-47
 */
export function speechLocale(lang) {
  return lang === 'ja' ? 'ja-JP' : 'en-US'
}

/**
 * 音声認識のコンストラクタ（未対応ブラウザでは null）。
 * @param {any} win `window`
 * @returns {Function|null} コンストラクタ
 */
export function recognitionCtor(win) {
  if (!win) return null
  return win.SpeechRecognition || win.webkitSpeechRecognition || null
}

/**
 * 送信できる状態か。
 * @param {string} text 種
 * @returns {boolean} 送信可否
 */
export function canSubmit(text) {
  const trimmed = String(text ?? '').trim()
  return trimmed.length > 0 && trimmed.length <= SEED_MAX
}

/**
 * 認識中の暫定文を確定文へ足す（二重スペースを作らない）。
 * @param {string} base 確定済み
 * @param {string} interim 暫定
 * @returns {string} 合成結果
 */
export function mergeTranscript(base, interim) {
  const left = String(base ?? '').trim()
  const right = String(interim ?? '').trim()
  if (!right) return left
  if (!left) return right
  // 日本語は空白を挟まない（読み上げの区切りで不自然な隙間を作らない）
  return /[\u3000-\u9fff\uff00-\uffef]$/.test(left) ? `${left}${right}` : `${left} ${right}`
}

/**
 * `POST /api/architect/seed` の本文。
 * @param {{seedText: string, autoStart?: boolean, runner?: string, board?: string, repo?: string|null, chat?: string|null, lang?: string}} input 入力
 * @returns {object} 本文
 */
export function buildSeedPayload({ seedText, autoStart = false, runner = 'hermes', board, repo = null, chat = null, lang = 'ja' }) {
  const body = {
    seedText: String(seedText ?? '').trim().slice(0, SEED_MAX),
    autoStart: Boolean(autoStart),
    runner: runner === 'antigravity' ? 'antigravity' : 'hermes',
    lang: lang === 'en' ? 'en' : 'ja',
  }
  if (board) body.board = String(board)
  if (repo) body.repo = String(repo)
  if (chat) body.chat = String(chat)
  return body
}

/**
 * ジョブの状態 → i18n キー。
 * @param {string} status 状態
 * @returns {string} キー
 */
export function jobStatusKey(status) {
  switch (status) {
    case 'running':
      return 'seed.statusRunning'
    case 'awaiting_spec':
      return 'seed.statusAwaiting'
    case 'spec_ready':
      return 'seed.statusReady'
    case 'launched':
      return 'seed.statusLaunched'
    case 'failed':
      return 'seed.statusFailed'
    default:
      return 'seed.statusUnknown'
  }
}

/**
 * Chat / Tasks に出す A2B クイック起票カードの材料を 1 つ選ぶ。
 *
 * 優先順: ① Architect が完成した SPEC（未起票あり・未起票のまま）→ ② 未起票 SPEC のうち最新。
 * 起票済み（`launched`）は出さない（二重起票の押し間違いを作らない）。
 *
 * @param {{specReady?: Array<object>, pending?: Array<object>}} input 入力
 * @returns {{kind: 'ready'|'pending', path: string, title: string, count: number, ids: string[], jobId: string|null, autoStart: boolean}|null} バナー
 */
export function pickSpecBanner({ specReady = [], pending = [] } = {}) {
  const ready = (Array.isArray(specReady) ? specReady : []).find(
    (row) => row && !row.launched && Number(row.batchCount) > 0,
  )
  if (ready) {
    const ids = (Array.isArray(ready.batches) ? ready.batches : []).map((b) => String(b?.id ?? '')).filter(Boolean)
    return {
      kind: 'ready',
      path: String(ready.spec),
      title: String(ready.title ?? ready.spec),
      count: Number(ready.batchCount) || ids.length,
      ids,
      jobId: ready.jobId ?? null,
      autoStart: Boolean(ready.autoStart),
    }
  }
  const next = (Array.isArray(pending) ? pending : []).find((row) => row && Number(row.pendingCount) > 0)
  if (!next) return null
  return {
    kind: 'pending',
    path: String(next.path),
    title: String(next.title ?? next.path),
    count: Number(next.pendingCount) || 0,
    ids: (Array.isArray(next.pending) ? next.pending : []).map((id) => String(id ?? '')).filter(Boolean),
    jobId: null,
    autoStart: false,
  }
}
