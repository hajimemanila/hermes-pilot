/**
 * 保存領域（`localStorage` / `sessionStorage`）の安全な取得。
 *
 * このモジュールが **唯一の定義**（SPEC-COHERENCE-SWEEP-3 §3.5 / CSW3-8）。以前は
 * `demo/frame.js`・`lib/vibe.js`・`lib/soundFx.js` に同じ役割の実装が 3 つあった。
 *
 * - ネイティブが例外を投げる環境（サンドボックス iframe・プライベートモードの quota 0）でも
 *   落ちない。読めない・書けないときは**メモリ実装へ落ちる**
 * - `win` を渡さない（Node のテストなど）ときもメモリ実装を返すので、呼び出し側は `try` を
 *   書かなくてよい
 */

/**
 * メモリだけの Storage 代替（サンドボックスでも例外を投げない）。
 *
 * @returns {object} `Storage` 互換のオブジェクト
 */
export function createMemoryStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => {
      map.set(String(key), String(value))
    },
    removeItem: (key) => {
      map.delete(String(key))
    },
    clear: () => map.clear(),
    key: (index) => [...map.keys()][Number(index)] ?? null,
    get length() {
      return map.size
    },
  }
}

/**
 * 保存領域を安全に取り出す（ネイティブが例外を投げる環境ではメモリ実装）。
 *
 * @param {'localStorage'|'sessionStorage'} [kind] 種類
 * @param {Window} [win] 対象の window
 * @returns {Storage|object} 使える保存領域
 */
export function safeStorage(kind = 'localStorage', win = globalThis.window) {
  const memKey = `__hmMem_${kind}`
  const fallback = () => {
    if (!win) return createMemoryStorage()
    if (!win[memKey]) {
      try {
        Object.defineProperty(win, memKey, { value: createMemoryStorage(), configurable: true })
      } catch {
        return createMemoryStorage()
      }
    }
    return win[memKey]
  }
  try {
    const native = win?.[kind]
    if (!native) return fallback()
    // 参照できても書き込みで落ちる環境（プライベートモードの quota 0）を弾く
    const probe = '__hm_probe__'
    native.setItem(probe, '1')
    native.removeItem(probe)
    return native
  } catch {
    return fallback()
  }
}
