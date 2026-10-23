/**
 * ウィジェット等の外部アプリから PWA の特定画面を開くための最小ディープリンク。
 *
 * 受け付ける形（優先順）:
 *   1. ハッシュ: `#inbox` / `#inbox:<task>` / `#chat`
 *   2. クエリ:   `?open=inbox[&task=<id>&board=<slug>]`, `?open=chat`
 *   3. パス:     `/inbox`, `/chat`
 *
 * ハッシュは同一ドキュメント内の遷移なので、WebAPK が「同じページ」として復元しても
 * hashchange で拾える。クエリは読み取り後に消すので、リロードで勝手に開き直らない。
 *
 * @returns {{open: string, task: string|null, board: string|null}|null}
 */
export function readDeepLink() {
  try {
    const params = new URLSearchParams(window.location.search)
    const hash = window.location.hash.replace(/^#/, '')
    const [hashOpenRaw, hashTaskRaw] = hash.split(':')
    const hashOpen = hashOpenRaw === 'inbox' || hashOpenRaw === 'chat' ? hashOpenRaw : null

    const path = window.location.pathname.replace(/\/+$/, '')
    const pathOpen = path === '/inbox' ? 'inbox' : path === '/chat' ? 'chat' : null

    const open = hashOpen || pathOpen || params.get('open')
    if (!open) return null

    const link = {
      open,
      task: params.get('task') || hashTaskRaw || null,
      board: params.get('board') || null,
    }

    // クエリだけ掃除する（ハッシュは同一ドキュメント遷移の合図なのでそのまま）
    params.delete('open')
    params.delete('task')
    params.delete('board')
    const qs = params.toString()
    window.history.replaceState(
      {},
      '',
      window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
    )
    return link
  } catch {
    return null
  }
}
