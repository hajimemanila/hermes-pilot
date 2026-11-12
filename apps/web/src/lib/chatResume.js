/**
 * チャットを開いたときに、どの会話へ戻るかを決める（純関数）。
 *
 * 背景（実測）: 端末の `hm.storedSid` が空だと、たとえ同じプロファイルの会話が
 * 残っていても画面は「メッセージを送って開始」のまま何も出ない。会話は
 * サーバ側に普通にあるので、直近の会話を選んで戻す。
 */

/**
 * @param {{storedSid?: string|null, sessions?: Array<{id:string, profile?:string, started_at?:number, updated_at?:number}>,
 *          profile?: string}} input
 * @returns {{sid: string, from: 'stored'|'recent'}|null}
 */
export function pickResumeTarget({ storedSid, sessions, profile } = {}) {
  if (storedSid) return { sid: storedSid, from: 'stored' }
  const want = profile || 'default'
  const list = (sessions || []).filter((s) => s && s.id && (s.profile || 'default') === want)
  if (!list.length) return null
  const stamp = (s) => Number(s.updated_at ?? s.started_at ?? 0) || 0
  const best = list.reduce((a, b) => (stamp(b) > stamp(a) ? b : a))
  return { sid: best.id, from: 'recent' }
}

/** 同じプロファイルの直近セッションを新しい順に n 件返す（空状態の導線用）。 */
export function recentSessions(sessions, profile, n = 3) {
  const want = profile || 'default'
  const stamp = (s) => Number(s.updated_at ?? s.started_at ?? 0) || 0
  return (sessions || [])
    .filter((s) => s && s.id && (s.profile || 'default') === want)
    .sort((a, b) => stamp(b) - stamp(a))
    .slice(0, n)
}
