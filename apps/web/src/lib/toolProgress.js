/**
 * チャットの進捗表示（Discord で見えているツール呼び出しを PWA でも出す）。
 *
 * 上流（Hermes の `/api/ws`）は `tool.start` / `tool.complete` を流している。
 * PWA 側でこれを1行に畳んで出すと「動いている／止まっている」が一目で分かる。
 * 純関数にしてテストで固定する。
 */

const MAX_ROWS = 8
const MAX_DETAIL = 56

/** ツール名と引数から、1行で読める短い説明を作る。 */
export function toolDetail(name, args) {
  const a = args && typeof args === 'object' ? args : {}
  const pick = (v) => (typeof v === 'string' ? v : '')
  const first = (...keys) => {
    for (const k of keys) {
      const v = pick(a[k]).trim()
      if (v) return v
    }
    return ''
  }
  let s = ''
  switch (name) {
    case 'terminal':
      s = first('command')
      break
    case 'execute_code':
      s = first('code')
      break
    case 'write_file':
    case 'patch':
    case 'read_file':
      s = first('path', 'file_path')
      break
    case 'browser_exec':
      s = first('code')
      break
    case 'web_search':
      s = first('query')
      break
    case 'delegate_task':
      s = first('goal')
      break
    case 'kanban_create':
    case 'kanban_comment':
      s = first('title', 'text', 'task_id')
      break
    default:
      s = first('command', 'path', 'query', 'goal', 'text')
  }
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length > MAX_DETAIL) s = s.slice(0, MAX_DETAIL - 1) + '…'
  return s
}

/**
 * progress 配列にイベントを1件反映する（新しい配列を返す）。
 *
 * @param {Array<{id:string,name:string,detail:string,done:boolean,ms?:number}>} list
 * @param {{kind:'start'|'complete', id?:string, name?:string, args?:object, duration_ms?:number}} ev
 */
export function mergeProgress(list, ev) {
  const rows = Array.isArray(list) ? list.slice() : []
  const id = String(ev?.id || ev?.name || '')
  if (ev?.kind === 'start') {
    rows.push({ id, name: String(ev.name || 'tool'), detail: toolDetail(ev.name, ev.args), done: false })
    return rows.slice(-MAX_ROWS)
  }
  if (ev?.kind === 'complete') {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].id === id && !rows[i].done) {
        rows[i] = { ...rows[i], done: true, ms: Number(ev.duration_ms) || undefined }
        return rows
      }
    }
  }
  return rows
}
