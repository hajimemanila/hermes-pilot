/**
 * 動的 import（`React.lazy`）が失敗したときの自動復旧（SPEC-UI-POLISH-V22 / Batch U3）。
 *
 * PWA を入れっぱなしで使っていると、スリープ復帰や再デプロイの直後に
 * `TermPane-<hash>.js` のような**古いハッシュのチャンク**を取りに行って
 * 「Failed to fetch dynamically imported module」で落ちる。原因は端末ではなく
 * 配信側のハッシュが入れ替わったことなので、ユーザーに「再試行」を押させる前に
 * 次の 2 段で直す:
 *
 * 1. `retryImport` — 瞬断（オフライン復帰直後など）は少し空けて数回だけ刺し直す。
 *    チャンク読み込み以外の例外（実装バグ）はリトライしない。
 * 2. `reloadForChunkError` — それでも駄目なら**1 回だけ**ページを読み直す。
 *    ただし `CHUNK_RELOAD_COOLDOWN_MS`（30 秒）以内の再発では読み直さない。
 *    読み直しても直らないときに無限リロードで端末を焼かないための歯止め。
 *
 * 最後に読み直した時刻は `sessionStorage` に置く（タブを閉じれば消える）。
 * `file://` やプライベートモードのように触るだけで例外になる環境では、
 * モジュール内のメモリに退避して同じ 30 秒クールダウンを効かせる。
 *
 * このファイルは React に依存しない（node:test からそのまま import して試せる）。
 */

/** チャンク読み直しの最短間隔（ミリ秒）。 */
export const CHUNK_RELOAD_COOLDOWN_MS = 30_000

/** 最後に読み直した時刻を置く `sessionStorage` のキー。 */
export const CHUNK_RELOAD_KEY = 'hermes-pilot:chunk-reload-at'

/**
 * ブラウザ／バンドラごとに文言が違うので、既知の言い回しを拾う。
 * （`name` が `ChunkLoadError` の webpack 系は別途 name で判定する）
 */
const CHUNK_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i, // Chrome / Edge / Vite
  /error loading dynamically imported module/i, // Firefox
  /importing a module script failed/i, // Safari
  /loading chunk\s*[\w-]*\s*failed/i, // webpack
  /loading css chunk\s*[\w-]*\s*failed/i, // webpack（CSS チャンク）
  /dynamically imported module.*(failed|error)/i,
]

/**
 * その例外が「チャンクが取れなかった」種類かどうか。
 * @param {unknown} error 例外（Error でも文字列でもよい）
 * @returns {boolean}
 */
export function isChunkLoadError(error) {
  if (!error) return false
  if (typeof error === 'object' && String(error.name ?? '') === 'ChunkLoadError') return true
  const message = String(error?.message ?? error)
  return CHUNK_ERROR_PATTERNS.some((re) => re.test(message))
}

/** メモリ退避用の最小ストア（`sessionStorage` が使えない環境むけ）。 */
const memoryStore = (() => {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value))
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
})()

/** `sessionStorage` が触れるならそれを、駄目ならメモリを返す。 */
function safeSessionStorage() {
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage) {
      // 読み書きできるかまで確かめる（Safari のプライベートモードは触ると投げる）
      const probe = `${CHUNK_RELOAD_KEY}:probe`
      sessionStorage.setItem(probe, '1')
      sessionStorage.removeItem(probe)
      return sessionStorage
    }
  } catch {
    /* フォールバックへ */
  }
  return memoryStore
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 動的 import を、チャンク読み込み失敗のときに限って刺し直す。
 *
 * @param {() => Promise<any>} importer `() => import('./features/TermPane.jsx')`
 * @param {{ retries?: number, delayMs?: number, sleep?: (ms: number) => Promise<void>, isChunkError?: (e: unknown) => boolean }} [options]
 * @returns {Promise<any>} 読み込めたモジュール（最後まで失敗したら最後の例外を投げる）
 */
export function retryImport(
  importer,
  { retries = 2, delayMs = 250, sleep = defaultSleep, isChunkError = isChunkLoadError } = {},
) {
  const attempt = async (n) => {
    try {
      return await importer()
    } catch (error) {
      // 実装バグ（チャンク以外）は何度刺しても直らないので即座に投げる
      if (n >= retries || !isChunkError(error)) throw error
      await sleep(delayMs * (n + 1))
      return attempt(n + 1)
    }
  }
  return attempt(0)
}

/**
 * 「30 秒クールダウン付きの単発リロード」を作る。テストから時計・ストレージ・
 * リロード関数を差し替えられるようにしてある。
 *
 * @param {{ storage?: { getItem(k: string): string|null, setItem(k: string, v: string): void },
 *   now?: () => number,
 *   reload?: () => void,
 *   cooldownMs?: number,
 *   key?: string }} [options]
 * @returns {(reason?: string) => boolean} 実際に読み直したら true、クールダウン中なら false
 */
export function createChunkReloader({
  storage,
  now = Date.now,
  reload = () => {
    if (typeof location !== 'undefined' && typeof location.reload === 'function') location.reload()
  },
  cooldownMs = CHUNK_RELOAD_COOLDOWN_MS,
  key = CHUNK_RELOAD_KEY,
} = {}) {
  const store = storage ?? safeSessionStorage()
  return function reloadOnce() {
    const at = now()
    let last = 0
    try {
      last = Number(store?.getItem(key) ?? 0) || 0
    } catch {
      last = 0
    }
    if (last && at - last < cooldownMs) return false
    try {
      store?.setItem(key, String(at))
    } catch {
      /* 記録できなくても読み直しはする（次の判定はメモリ側が受け持つ） */
    }
    reload()
    return true
  }
}

/** アプリが使う既定のリローダ（`sessionStorage` + `location.reload`）。 */
export const reloadForChunkError = createChunkReloader()
