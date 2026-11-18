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

/**
 * 履歴行が読み取り専用（継続して指示を送れない会話）かどうかを判定する。
 * カンバン作業ログ（`local-…` / `source === 'kanban'`）は Hermes が `session.resume` を
 * 拒否する（4132）ため、開く前から一覧上で区別できるようにする。
 *
 * @param {{id?: string, source?: string}|null|undefined} session
 * @param {string|null|undefined} [readonlySessionId] 現在読み取り専用で開いているセッション ID
 * @returns {boolean}
 */
export function isReadonlySession(session, readonlySessionId = null) {
  if (!session) return false
  const id = String(session.id ?? '').trim()
  if (!id) return false
  if (readonlySessionId && id === String(readonlySessionId).trim()) return true
  if (id.startsWith('local-')) return true
  if (String(session.source ?? '').trim().toLowerCase() === 'kanban') return true
  return false
}
