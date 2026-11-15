/**
 * スニペット／スタンプ帯の 3 個別表示トグル（SPEC-PILOT-V7 §3.4 / V7-4）。
 *
 * 対象は次の 3 箇所で、**既定はすべて表示**（未設定の端末は従来どおり）。
 *  - `chat`       … チャット下部の定型チップ帯
 *  - `annotation` … Annotation 赤入れのスタンプ帯
 *  - `term`       … ターミナルの定型コマンド帯
 *
 * 保存は `localStorage['hm.snippetBars.v1']` の 1 キーに `{ chat, annotation, term }`。
 * 帯を消しても**機能そのものは消さない**（チャットは入力欄の ＋ のシート、赤入れは
 * ツール列のスタンプボタン、ターミナルはヘッダの定型ボタンから開ける）。設定タブで
 * 切り替えた瞬間に他画面の帯も消したいので、`hm:snippet-bars` を飛ばして購読側が追従する
 * （リロード不要）。React に依存しない純関数だけを置き、`node --test` で検証する。
 */

/** localStorage のキー（SPEC で固定）。 */
export const SNIPPET_BARS_KEY = 'hm.snippetBars.v1'

/** 帯の識別子（この順で設定タブに並べる）。 */
export const SNIPPET_BAR_IDS = Object.freeze(['chat', 'annotation', 'term'])

/** 既定値（全 ON）。 */
export const SNIPPET_BAR_DEFAULTS = Object.freeze({ chat: true, annotation: true, term: true })

/** 変更通知のイベント名（設定タブ → 各画面）。 */
export const SNIPPET_BARS_EVENT = 'hm:snippet-bars'

/** 保存領域を返す（引数優先、無ければ localStorage。SSR／プライベートモードでは null）。 */
function resolveStore(storage) {
  if (storage) return storage
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/**
 * 保存値を `{ chat, annotation, term }` の boolean に正規化する。
 *
 * 未知のキーは捨て、欠けたキーは既定 `true`、boolean 以外の値（旧形式の文字列や
 * 数値、壊れた JSON の断片）は既定へ落とす。**読めない値で帯が消えることはない。**
 *
 * @param {unknown} raw localStorage から読んだ値（オブジェクトでも文字列でもよい）
 * @returns {{chat: boolean, annotation: boolean, term: boolean}} 正規化済みの状態
 */
export function normalizeSnippetBars(raw) {
  const out = { ...SNIPPET_BAR_DEFAULTS }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const id of SNIPPET_BAR_IDS) {
    const v = raw[id]
    if (typeof v === 'boolean') out[id] = v
    else if (v === 'true') out[id] = true
    else if (v === 'false') out[id] = false
    else if (v === 1) out[id] = true
    else if (v === 0) out[id] = false
  }
  return out
}

/**
 * 現在の状態を読む（未設定・壊れた JSON・storage 無しはすべて既定全 ON）。
 * @param {Storage} [storage] 差し替え用（テスト）
 * @returns {{chat: boolean, annotation: boolean, term: boolean}} 状態
 */
export function readSnippetBars(storage) {
  const s = resolveStore(storage)
  if (!s) return { ...SNIPPET_BAR_DEFAULTS }
  try {
    const text = s.getItem(SNIPPET_BARS_KEY)
    if (!text) return { ...SNIPPET_BAR_DEFAULTS }
    return normalizeSnippetBars(JSON.parse(text))
  } catch {
    return { ...SNIPPET_BAR_DEFAULTS }
  }
}

/**
 * 状態をまとめて書き出す（部分更新を渡すと現在値に重ねる）。
 * @param {object} patch 更新する項目だけのオブジェクト
 * @param {Storage} [storage] 差し替え用（テスト）
 * @returns {{chat: boolean, annotation: boolean, term: boolean}} 書き出した後の状態
 */
export function writeSnippetBars(patch, storage) {
  const s = resolveStore(storage)
  const base = readSnippetBars(s)
  const merged = patch && typeof patch === 'object' && !Array.isArray(patch) ? { ...base, ...patch } : base
  const next = normalizeSnippetBars(merged)
  try {
    s?.setItem(SNIPPET_BARS_KEY, JSON.stringify(next))
  } catch {
    /* 容量超過・プライベートモードでも UI は動かす */
  }
  return next
}

/**
 * 1 つの帯の表示可否。未知の id は「表示」（帯が消えて詰まるのを避ける）。
 * @param {{chat: boolean, annotation: boolean, term: boolean}} state 状態
 * @param {'chat'|'annotation'|'term'} id 帯の id
 * @returns {boolean} 表示するなら true
 */
export function isBarVisible(state, id) {
  const s = normalizeSnippetBars(state)
  if (!SNIPPET_BAR_IDS.includes(id)) return true
  return s[id] !== false
}

/**
 * 設定タブのトグル。保存してから `hm:snippet-bars` を飛ばし、他画面の帯を即座に追従させる。
 * @param {'chat'|'annotation'|'term'} id 帯の id
 * @param {boolean} value 新しい表示状態
 * @param {{storage?: Storage, target?: EventTarget}} [opts] 差し替え用（テスト）
 * @returns {{chat: boolean, annotation: boolean, term: boolean}} 更新後の状態
 */
export function setSnippetBar(id, value, opts = {}) {
  if (!SNIPPET_BAR_IDS.includes(id)) return readSnippetBars(opts.storage)
  const next = writeSnippetBars({ [id]: value !== false }, opts.storage)
  emitSnippetBars(next, opts.target)
  return next
}

/** 現在値の反転（`setSnippetBar` の薄い包み）。 */
export function toggleSnippetBar(id, opts = {}) {
  const cur = readSnippetBars(opts.storage)
  return setSnippetBar(id, !isBarVisible(cur, id), opts)
}

/**
 * 変更を飛ばす。CustomEvent が無い環境（古い Node）でも落ちないように素の Event で代替する。
 * @param {{chat: boolean, annotation: boolean, term: boolean}} next 通知する状態
 * @param {EventTarget} [target] 差し替え用（テスト。既定は window）
 * @returns {void}
 */
export function emitSnippetBars(next, target) {
  const t = target ?? (typeof window !== 'undefined' ? window : null)
  if (!t || typeof t.dispatchEvent !== 'function') return
  let ev
  try {
    ev = new CustomEvent(SNIPPET_BARS_EVENT, { detail: next })
  } catch {
    ev = { type: SNIPPET_BARS_EVENT, detail: next }
  }
  t.dispatchEvent(ev)
}

/**
 * 変更を購読する（自画面の `hm:snippet-bars` と、他タブからの `storage` の両方）。
 * @param {(state: {chat: boolean, annotation: boolean, term: boolean}) => void} fn 受け手
 * @param {EventTarget} [target] 差し替え用（テスト。既定は window）
 * @returns {() => void} 解除関数
 */
export function subscribeSnippetBars(fn, target) {
  const t = target ?? (typeof window !== 'undefined' ? window : null)
  if (!t || typeof t.addEventListener !== 'function') return () => {}
  const onLocal = (e) => fn(normalizeSnippetBars(e?.detail))
  const onStorage = (e) => {
    if (e && e.key && e.key !== SNIPPET_BARS_KEY) return
    fn(readSnippetBars())
  }
  t.addEventListener(SNIPPET_BARS_EVENT, onLocal)
  t.addEventListener('storage', onStorage)
  return () => {
    t.removeEventListener(SNIPPET_BARS_EVENT, onLocal)
    t.removeEventListener('storage', onStorage)
  }
}
