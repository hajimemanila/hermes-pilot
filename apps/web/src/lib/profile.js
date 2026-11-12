/**
 * PWA チャットの既定プロファイルと、既定を切り替えたときの一度きりの移行。
 *
 * 決定: 赤ペン `sheets/mobile-profile-01-1.html` Q4=A（mobile を既定にし、端末に
 * 保存済みの選択も一度リセットする）。`ChatPane.jsx` は localStorage の
 * `hm.storedProfile` を復元するので、既定値だけ変えても効かない。
 */

/** 既定プロファイル（"mobile" を主プロファイルにした）。 */
export const DEFAULT_PROFILE = 'mobile'

/** 端末に保存した「直近の会話のプロファイル」。 */
export const STORED_PROFILE_KEY = 'hm.storedProfile'

/** 既定を切り替えた目印。値が現在の既定と違えば移行を1回だけ行う。 */
export const DEFAULT_PROFILE_MARK = 'hm.defaultProfile'

/**
 * 端末に残った「前の既定の選択」を1回だけ捨てる。
 *
 * 保存済みの選択を消し、目印を現在の既定で上書きする。2回目以降は何もしない
 * （利用者が自分で選び直したプロファイルを尊重する）。
 *
 * @param {{getItem: Function, setItem: Function, removeItem: Function}} [storage]
 *   端末ストレージ（テストからは Map 相当を渡す）。既定は localStorage。
 * @returns {boolean} 移行を実行したら true
 */
export function applyDefaultProfile(storage = globalThis.localStorage) {
  try {
    if (!storage || storage.getItem(DEFAULT_PROFILE_MARK) === DEFAULT_PROFILE) return false
    storage.removeItem(STORED_PROFILE_KEY)
    storage.setItem(DEFAULT_PROFILE_MARK, DEFAULT_PROFILE)
    return true
  } catch {
    // ストレージが無い / 拒否された / 容量超過。起動は止めない
    return false
  }
}
