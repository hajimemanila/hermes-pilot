/**
 * チャットの進捗表示（Discord で見えているツール呼び出しを PWA でも出す）。
 *
 * 上流（Hermes の `/api/ws`）は `tool.start` / `tool.complete` を流している。
 * PWA 側でこれを1行に畳んで出すと「動いている／止まっている」が一目で分かる。
 * 純関数にしてテストで固定する。
 */

const MAX_ROWS = 8
const MAX_DETAIL = 56
const MAX_FULL = 400

/**
 * ファイルパスやコマンドを、末尾（ファイル名など重要部分）を残して短くする。
 * @param {string} raw 元文字列
 * @param {number} [maxLen] 上限長
 */
export function shortenPath(raw, maxLen = 44) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!s || s.length <= maxLen) return s
  // 空白を含まず / を含む場合はパスとして末尾 2 セグメントを優先表示する
  if (!/\s/.test(s) && s.includes('/')) {
    const parts = s.split('/').filter(Boolean)
    if (parts.length >= 2) {
      const tail = `…/${parts.slice(-2).join('/')}`
      if (tail.length <= maxLen) return tail
    }
    return `…${s.slice(-(maxLen - 1))}`
  }
  return `${s.slice(0, maxLen - 1)}…`
}

function extractRawArg(name, args) {
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
      s = first('command', 'path', 'file_path', 'query', 'goal', 'text')
  }
  return s.replace(/\s+/g, ' ').trim()
}

/** ツール名と引数から全文（タップ展開用）を取り出す。 */
export function toolFullDetail(name, args) {
  const s = extractRawArg(name, args)
  if (s.length > MAX_FULL) return `${s.slice(0, MAX_FULL - 1)}…`
  return s
}

/** ツール名と引数から、1行で読める短い説明を作る（パスは末尾を残す）。 */
export function toolDetail(name, args) {
  const s = extractRawArg(name, args)
  if (!s) return ''
  if (name === 'write_file' || name === 'patch' || name === 'read_file' || (!/\s/.test(s) && s.includes('/'))) {
    return shortenPath(s, MAX_DETAIL)
  }
  if (s.length > MAX_DETAIL) return `${s.slice(0, MAX_DETAIL - 1)}…`
  return s
}

/**
 * progress 配列にイベントを1件反映する（新しい配列を返す）。
 *
 * @param {Array<{id:string,name:string,detail:string,full?:string,done:boolean,ms?:number}>} list
 * @param {{kind:'start'|'complete', id?:string, name?:string, args?:object, duration_ms?:number}} ev
 */
export function mergeProgress(list, ev) {
  const rows = Array.isArray(list) ? list.slice() : []
  const id = String(ev?.id || ev?.name || '')
  if (ev?.kind === 'start') {
    rows.push({
      id,
      name: String(ev.name || 'tool'),
      detail: toolDetail(ev.name, ev.args),
      full: toolFullDetail(ev.name, ev.args),
      done: false,
    })
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

/**
 * `/api/sessions/:id/transcript?tools=1` の行配列から、ツール呼び出しを直後（または直前）の
 * assistant ブロックへ折りたたみサマリとして紐づける。
 *
 * @param {Array<object>} messages transcript API の messages
 * @param {(v:any)=>number} [toEpochMsFn] 時刻変換
 * @returns {{blocks: Array<object>, trailingTools: Array<object>}}
 */
export function foldTranscriptMessages(messages, toEpochMsFn = (x) => Number(x) || 0) {
  const blocks = []
  let pendingTools = []
  for (let i = 0; i < (messages ?? []).length; i += 1) {
    const m = messages[i]
    if (!m) continue
    if (m.role === 'tool') {
      const raw = String(m.text ?? '').replace(/\s+/g, ' ').trim()
      pendingTools.push({
        id: String(m.id ?? i),
        name: String(m.toolName || 'tool'),
        detail: shortenPath(raw, 56),
        full: String(m.text ?? '').slice(0, 300),
        done: true,
        at: toEpochMsFn(m.at ?? m.timestamp ?? m.created_at),
      })
      continue
    }
    if (m.role === 'user') {
      if (pendingTools.length && blocks.length && blocks[blocks.length - 1].role === 'assistant') {
        const last = blocks[blocks.length - 1]
        blocks[blocks.length - 1] = { ...last, tools: [...(last.tools ?? []), ...pendingTools] }
        pendingTools = []
      }
      blocks.push({
        role: 'user',
        text: String(m.text ?? ''),
        mid: m.id,
        at: toEpochMsFn(m.at ?? m.timestamp ?? m.created_at),
      })
      pendingTools = []
      continue
    }
    if (m.role === 'assistant') {
      const block = {
        role: 'assistant',
        text: String(m.text ?? ''),
        mid: m.id,
        at: toEpochMsFn(m.at ?? m.timestamp ?? m.created_at),
      }
      if (pendingTools.length) {
        block.tools = pendingTools
        pendingTools = []
      }
      blocks.push(block)
    }
  }
  const trailingTools = pendingTools.slice()
  if (trailingTools.length && blocks.length && blocks[blocks.length - 1].role === 'assistant') {
    const last = blocks[blocks.length - 1]
    blocks[blocks.length - 1] = { ...last, tools: [...(last.tools ?? []), ...trailingTools] }
  }
  return { blocks, trailingTools }
}
