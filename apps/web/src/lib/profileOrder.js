/**
 * 新しい会話シートに並べるプロファイルの順序（SPEC §5.3）。
 *
 * (1) `DEFAULT_PROFILE`（この端末の既定）
 * (2) `'default'`（Hermes の本体プロファイル）
 * (3) 直近利用順（セッションの最終活動が新しい順）
 * (4) 名前順
 *
 * プロファイル名を決め打ちしない（個人環境の名称を UI に埋めない）。
 */

/**
 * プロファイル一覧を並べる。
 * @param {string[]} profiles サーバが返したプロファイル名
 * @param {Array<{profile?: string, started_at?: number|null}>} sessions 直近のセッション（最終活動の材料）
 * @param {string} defaultProfile 既定プロファイル
 * @returns {string[]} 並べ替えたプロファイル名（重複なし）
 */
export function orderProfiles(profiles = [], sessions = [], defaultProfile = '') {
  const list = Array.isArray(profiles) && profiles.length ? profiles : [defaultProfile]
  const lastUsed = new Map()
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const name = s?.profile
    if (!name) continue
    const at = Number(s?.started_at ?? 0)
    if (!Number.isFinite(at)) continue
    if (at > (lastUsed.get(name) ?? -1)) lastUsed.set(name, at)
  }
  const rank = (p) => (p === defaultProfile ? 0 : p === 'default' ? 1 : 2)
  return [...new Set(list.filter(Boolean))].sort(
    (a, b) => rank(a) - rank(b) || (lastUsed.get(b) ?? -1) - (lastUsed.get(a) ?? -1) || a.localeCompare(b),
  )
}
