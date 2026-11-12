import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

/**
 * 赤ペン（akapen）パイプラインのブリッジ側。
 *
 * 契約は `~/Projects/akapen/CONTRACT.md`。カンバン（board `mobile`）が唯一の真実で、
 * シートはボードの default_workdir 配下に置かれる。ここは**読み取り + 回答の書き込み**だけを行い、
 * 実装判断はしない（生成も反映も worker の仕事）。
 *
 * パスの解決規則:
 *  - シートの場所はタスク本文の `[akapen] ... sheet=...` 行から取る（リクエストのパスは使わない）
 *  - 解決後 realpath が workdir 配下でなければ拒否する（allowlist）
 */

const LINE_RE = /^\[akapen\]\s+(.+)$/m
const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,40}$/i

/** タスク本文から `[akapen] label=... round=... mode=... sheet=...` を取り出す。 */
export function parseAkapenLine(body) {
  const m = LINE_RE.exec(String(body || ''))
  if (!m) return null
  const out = {}
  for (const token of m[1].trim().split(/\s+/)) {
    const idx = token.indexOf('=')
    if (idx > 0) out[token.slice(0, idx)] = token.slice(idx + 1)
  }
  // シートは `sheet=` が正だが、`image=<....html>` と書かれた実例がある（NO_SHEET になった）。
  // html を指しているときだけ別名として受ける。
  if (!out.sheet && out.image && /\.html?$/i.test(out.image)) out.sheet = out.image
  if (!out.sheet && !out.label) return null
  if (out.sheet && !isSafeRel(out.sheet)) return null
  return out
}

/** 相対パスとして妥当か（親ディレクトリ・絶対パスを弾く）。 */
export function isSafeRel(rel) {
  const s = String(rel || '')
  if (!s || s.startsWith('/') || s.includes('..') || s.includes('\0')) return false
  return /^[A-Za-z0-9._/-]+$/.test(s)
}

/** 回答の安定ハッシュ（キー順を固定して二重投稿を検出する）。 */
export function answerHash({ answers = [], global = '', annotations = [] }) {
  const norm = {
    answers: [...answers]
      .map((a) => ({ id: String(a.id ?? ''), choice: a.choice ?? null, note: String(a.note ?? '') }))
      .sort((x, y) => x.id.localeCompare(y.id)),
    global: String(global ?? ''),
    annotations: [...annotations].map((a) => ({ region: a.region ?? null, note: String(a.note ?? '') })),
  }
  return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex')
}

/** 回答を【赤ペン回答】互換テキストにする（貼り戻し経路と同じ形）。 */

/** 【赤ペン回答】テキストを構造化する（シートが直接送ってきた場合に使う）。 */
export function parseReplyText(text) {
  const out = { answers: [], global: '' }
  const lines = String(text || '').split(/\r?\n/)
  let inGlobal = false
  for (const line of lines) {
    if (line.trim() === '---') break
    const q = /^Q(\d+)\.\s*(.*?):\s*(.*)$/.exec(line)
    if (q) {
      const rest = q[3]
      const m = /^(.*?)(?:\s*\/\s*補足:\s*(.*))?$/.exec(rest)
      const choice = (m?.[1] || '').trim()
      out.answers.push({
        id: `q${q[1]}`,
        choice: choice.startsWith('(未選択') ? null : choice,
        note: (m?.[2] || '').trim(),
      })
      inGlobal = false
      continue
    }
    const g = /^全体への赤ペン:\s*(.*)$/.exec(line)
    if (g) {
      out.global = g[1] || ''
      inGlobal = true
      continue
    }
    if (inGlobal) out.global += `\n${line}`
  }
  out.global = out.global.trim()
  return out
}

export function toReplyText(label, answers, global, questions = []) {
  const title = new Map(questions.map((q) => [String(q.id), String(q.text ?? '')]))
  const lines = [`【赤ペン回答】${label}`]
  for (const a of answers) {
    const q = title.get(String(a.id)) || String(a.id)
    const choice = a.choice === null || a.choice === undefined ? '(未選択 = お任せ)' : String(a.choice)
    const note = a.note ? ` / 補足: ${String(a.note).replace(/\n/g, ' ')}` : ''
    lines.push(`Q${String(a.id).replace(/^q/i, '')}. ${q}: ${choice}${note}`)
  }
  lines.push(`全体への赤ペン: ${String(global ?? '').replace(/\r/g, '')}`)
  lines.push('---')
  lines.push('上の回答を反映して作業を続けてください。お任せの項目は推奨案で確定してください。')
  return `${lines.join('\n')}\n`
}

/**
 * シート HTML に「回答をアプリへ送る」小さなブリッジを注入する（保存物は書き換えない）。
 *
 * アプリ内で開いたときだけ、設問見出し (Q1…) をマーカーで装飾する（赤ペン注釈の指摘）。
 * 保存済みのシート（file:// で開く原本）は書き換えないので、装飾はアプリ表示の担当。
 */
export function injectAkapenBridge(html, taskId) {
  const style = `
<style id="akBridgeStyle">
#akForm .q h3{
  display:inline-block;
  max-width:100%;
  margin:0 0 10px -3px;
  padding:1px 6px 2px;
  font-size:16px;
  font-weight:700;
  line-height:1.6;
  border-radius:3px;
  background:linear-gradient(180deg,rgba(250,204,21,0) 44%,rgba(250,204,21,.62) 44%,rgba(250,204,21,.62) 96%,rgba(250,204,21,0) 96%);
}
</style>
`
  const script = `
<script>
(function () {
  var TASK = ${JSON.stringify(String(taskId))};
  function replyText() { var o = document.getElementById('out'); return o ? o.value : ''; }
  function report(ok, msg) {
    var el = document.getElementById('akBridgeStatus');
    if (!el) {
      el = document.createElement('div');
      el.id = 'akBridgeStatus';
      el.style.cssText = 'margin:12px 0;padding:10px 12px;border-radius:10px;font:inherit;font-size:13px;line-height:1.6';
      (document.getElementById('akForm') || document.body).appendChild(el);
    }
    el.style.background = ok ? '#e7f8f1' : '#fdecea';
    el.style.color = ok ? '#0b5f45' : '#8a1f17';
    el.textContent = msg;
  }
  function submit() {
    var text = replyText();
    if (!text || text.indexOf('【赤ペン回答】') === -1) return;
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'akapen:reply', taskId: TASK, text: text }, '*');
      report(true, 'アプリに回答を送りました（この画面は閉じてOK）');
      return;
    }
    fetch('/api/akapen/' + TASK + '/answer', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-client': 'mobile' },
      body: JSON.stringify({ text: text })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        var ok = res.ok && res.j && res.j.ok;
        report(ok, ok ? '回答を送信しました（タスクは ' + (res.j.moved || '') + '）'
                      : '送信できませんでした: ' + ((res.j && ((res.j.error && res.j.error.message) || res.j.message)) || 'unknown'));
      })
      .catch(function (e) { report(false, '送信エラー: ' + e.message); });
  }
  // アプリ経由で開いているときは「貼り付ける」ではなく「送信」として見せる
  function relabel() {
    var b = document.getElementById('genBtn');
    if (b) b.textContent = '回答を送信';
    var note = document.querySelector('#akForm p.m');
    if (note) note.textContent = '選んで［回答を送信］を押すと、そのままアプリに送られます（未選択は推奨案で確定）。';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', relabel);
  else relabel();

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t && (t.id === 'genBtn' || (t.closest && t.closest('#genBtn')))) setTimeout(submit, 80);
  }, true);
  window.__akapenSubmit = submit;
})();
</script>
`
  const inject = `${style}${script}`
  return html.includes('</body>') ? html.replace('</body>', `${inject}\n</body>`) : html + inject
}

/**
 * @param {object} cfg ブリッジ設定（kanbanRoot を使う）
 * @param {{board?: string, root?: string}} [opts]
 */
export function createAkapen(cfg, opts = {}) {
  const board = opts.board || process.env.AKAPEN_BOARD || 'mobile'
  const boardDir = path.join(cfg.kanbanRoot, 'boards', board)
  const dbPath = path.join(boardDir, 'kanban.db')

  /** ボードの default_workdir（シート置き場のルート）。 */
  function workdir() {
    if (opts.root) return path.resolve(opts.root.replace(/^~/, os.homedir()))
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(boardDir, 'board.json'), 'utf8'))
      if (meta.default_workdir) return path.resolve(String(meta.default_workdir).replace(/^~/, os.homedir()))
    } catch {
      /* fall through */
    }
    return path.join(os.homedir(), 'Projects', 'akapen')
  }

  function openDb() {
    return new DatabaseSync(dbPath, { readOnly: true })
  }

  function rows(limit = 80) {
    let db
    try {
      db = openDb()
    } catch {
      return []
    }
    try {
      return db
        .prepare(
          `SELECT id, title, body, status, assignee, priority,
                  created_at, started_at, completed_at, result, last_heartbeat_at
             FROM tasks
            WHERE status IN ('review','ready','running','blocked','done')
            ORDER BY CASE status WHEN 'review' THEN 0 WHEN 'ready' THEN 1 WHEN 'running' THEN 2
                                 WHEN 'blocked' THEN 3 ELSE 4 END,
                     COALESCE(completed_at, started_at, created_at) DESC
            LIMIT ?`,
        )
        .all(limit)
    } catch {
      return []
    } finally {
      db.close()
    }
  }

  /** 各タスクの最新イベント（進行が見えるように）。 */
  function lastEvents(ids) {
    if (!ids.length) return {}
    let db
    try {
      db = openDb()
    } catch {
      return {}
    }
    try {
      const placeholders = ids.map(() => '?').join(',')
      const rs = db
        .prepare(
          `SELECT task_id, kind, created_at FROM task_events
            WHERE id IN (SELECT MAX(id) FROM task_events WHERE task_id IN (${placeholders}) GROUP BY task_id)`,
        )
        .all(...ids)
      const out = {}
      for (const r of rs) out[r.task_id] = { kind: r.kind, at: Number(r.created_at ?? 0) * 1000 }
      return out
    } catch {
      return {}
    } finally {
      db.close()
    }
  }

  function bodyOf(id) {
    let db
    try {
      db = openDb()
    } catch {
      return null
    }
    try {
      return db.prepare('SELECT body, status, title FROM tasks WHERE id = ?').get(id) || null
    } catch {
      return null
    } finally {
      db.close()
    }
  }

  /** このタスクを実行している worker のセッション ID（無ければ null）。 */
  function sessionId(id) {
    let db
    try {
      db = openDb()
    } catch {
      return null
    }
    try {
      const r = db.prepare('SELECT session_id, status FROM tasks WHERE id = ?').get(id)
      if (r?.session_id) return { sessionId: String(r.session_id), status: r.status }
      // complete --force などで tasks.session_id が空になる。イベントの payload から拾う
      const evs = db
        .prepare(
          "SELECT payload FROM task_events WHERE task_id = ? AND kind IN ('owner_admitted','worker_bound','spawned') ORDER BY id DESC LIMIT 6",
        )
        .all(id)
      for (const ev of evs) {
        try {
          const p = JSON.parse(ev.payload || '{}')
          if (p.session_id) {
            return { sessionId: String(p.session_id), status: r?.status ?? null, db: p.db || null }
          }
        } catch {
          /* 壊れた payload は無視 */
        }
      }
      return null
    } catch {
      return null
    } finally {
      db.close()
    }
  }

  /** workdir 配下に収まることを realpath で確かめて絶対パスを返す。 */
  function resolveInside(rel) {
    if (!isSafeRel(rel)) return null
    const root = workdir()
    const abs = path.resolve(root, rel)
    const relToRoot = path.relative(root, abs)
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return null
    try {
      return fs.realpathSync(abs)
    } catch {
      return null
    }
  }

  function readJsonIfExists(abs) {
    try {
      return JSON.parse(fs.readFileSync(abs, 'utf8'))
    } catch {
      return null
    }
  }

  /** 一覧（PWA の赤ペンタブ）。 */
  function list(limit = 80) {
    const out = []
    const base = rows(limit)
    const events = lastEvents(base.map((r) => r.id))
    for (const r of base) {
      const ak = parseAkapenLine(r.body)
      if (!ak) continue
      const sheetAbs = ak.sheet ? resolveInside(ak.sheet) : null
      const dataRel = ak.sheet ? ak.sheet.replace(/\.html$/, '.json') : null
      const dataAbs = dataRel ? resolveInside(dataRel) : null
      const sheet = dataAbs ? readJsonIfExists(dataAbs) : null
      const answerRel = ak.sheet ? ak.sheet.replace(/\.html$/, '.answer.json') : null
      const answered = answerRel ? readJsonIfExists(resolveInside(answerRel) || '\0') : null
      out.push({
        id: r.id,
        board,
        title: r.title,
        status: r.status,
        assignee: r.assignee,
        createdAt: Number(r.created_at ?? 0) * 1000,
        completedAt: r.completed_at ? Number(r.completed_at) * 1000 : null,
        result: r.result ? String(r.result).slice(0, 400) : null,
        progress: {
          lastEvent: events[r.id]?.kind ?? null,
          lastEventAt: events[r.id]?.at ?? null,
          heartbeatAt: r.last_heartbeat_at ? Number(r.last_heartbeat_at) * 1000 : null,
          startedAt: r.started_at ? Number(r.started_at) * 1000 : null,
        },
        akapen: {
          label: ak.label ?? null,
          image: ak.image ?? null,
          mode: ak.mode ?? 'standard',
          round: Number(ak.round ?? 1),
          sheet: ak.sheet ?? null,
          exists: Boolean(sheetAbs),
          title: sheet?.title ?? null,
          topic: sheet?.topic ?? null,
          questions: Array.isArray(sheet?.questions) ? sheet.questions.length : 0,
          answeredAt: answered?.answered_at ?? null,
        },
      })
    }
    return out
  }

  /** シート HTML（認可は呼び出し側）。 */
  function sheetHtml(id) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND', message: 'タスクがありません' }
    const ak = parseAkapenLine(b.body)
    if (!ak?.sheet) return { ok: false, code: 'NO_SHEET', message: 'このタスクにはシートがありません' }
    const abs = resolveInside(ak.sheet)
    if (!abs) return { ok: false, code: 'SHEET_MISSING', message: 'シートが見つかりません' }
    return { ok: true, html: fs.readFileSync(abs, 'utf8'), path: abs }
  }

  /** シートの構造化データ（PWA のネイティブフォーム用）。 */
  function sheetData(id) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND', message: 'タスクがありません' }
    const ak = parseAkapenLine(b.body)
    if (!ak?.sheet) return { ok: false, code: 'NO_SHEET', message: 'このタスクにはシートがありません' }
    const abs = resolveInside(ak.sheet.replace(/\.html$/, '.json'))
    const data = abs ? readJsonIfExists(abs) : null
    if (!data) return { ok: false, code: 'DATA_MISSING', message: 'sheet.json がありません' }
    // 回答の履歴（完了した項目を「なぜこの設計か」まで辿れるようにする）。
    // 回答は無いことがある（回答前に片付けた等）ので、無ければ null。
    const answer = readJsonIfExists(resolveInside(ak.sheet.replace(/\.html$/, '.answer.json')) || '\0')
    return { ok: true, data, answer: answer || null, taskId: id, status: b.status }
  }

  /** テストから差し替えられるように注入可能にしておく。 */
  const runKanban = opts.runKanban || function runKanbanReal(args) {
    return new Promise((resolve) => {
      execFile(
        'hermes',
        ['kanban', '--board', board, ...args],
        { timeout: 30000, maxBuffer: 1_000_000, env: { ...process.env } },
        (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}`.trim() })
        },
      )
    })
  }

  /**
   * 回答を保存して状態を進める（冪等）。
   *
   * @param {string} id タスク ID
   * @param {{answers: Array, global?: string, annotations?: Array, by?: string}} payload
   */
  async function answer(id, payload) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND', message: 'タスクがありません' }
    const ak = parseAkapenLine(b.body)
    if (!ak?.sheet) return { ok: false, code: 'NO_SHEET', message: 'このタスクにはシートがありません' }

    const sheetAbs = resolveInside(ak.sheet)
    const dataAbs = resolveInside(ak.sheet.replace(/\.html$/, '.json'))
    const data = dataAbs ? readJsonIfExists(dataAbs) : null
    const questions = Array.isArray(data?.questions) ? data.questions : []

    // シート HTML がそのまま送ってきた【赤ペン回答】も受ける
    const fromText =
      payload?.text && !(Array.isArray(payload?.answers) && payload.answers.length)
        ? parseReplyText(payload.text)
        : null
    const answers = fromText ? fromText.answers : Array.isArray(payload?.answers) ? payload.answers : []
    const global = fromText ? fromText.global : String(payload?.global ?? '')
    const annotations = Array.isArray(payload?.annotations) ? payload.annotations : []
    const hash = answerHash({ answers, global, annotations })

    const answerRel = ak.sheet.replace(/\.html$/, '.answer.json')
    const answerDir = path.dirname(path.resolve(workdir(), answerRel))
    const answerFile = path.join(answerDir, path.basename(answerRel))
    const textFile = answerFile.replace(/\.answer\.json$/, '.answer.txt')

    const existing = readJsonIfExists(answerFile)
    if (existing && existing.sha256 === hash) {
      // 回答は保存済み。遷移だけ未了なら（再送で）ここで進める — 冪等の本体はこの分岐
      let moved = { code: 0, out: '' }
      let status = b.status
      if (b.status === 'blocked') {
        moved = await runKanban(['unblock', id, '--reason', '赤ペン回答を受領（再送）'])
        if (moved.code === 0) status = 'ready'
      }
      return {
        ok: moved.code === 0,
        duplicate: true,
        sha256: hash,
        status,
        moved: status,
        message: '同じ回答が既に保存されています',
        output: moved.out.slice(0, 400),
      }
    }
    // 回答は「赤ペン待ち（blocked）」のときだけ受け付ける。ready / running / review / done へ
    // 送ると answer.json を上書きし、comment が二重に付く（赤ペンシートの付録 1-2）。
    if (b.status !== 'blocked') {
      return {
        ok: false,
        code: 'NOT_WAITING',
        status: b.status,
        message: `赤ペン待ちではありません（現在: ${b.status}）`,
      }
    }

    const record = {
      label: ak.label ?? null,
      round: Number(ak.round ?? 1),
      task_id: id,
      answered_at: new Date().toISOString(),
      answers: answers.map((a) => ({
        id: String(a?.id ?? ''),
        choice: a?.choice ?? null,
        note: String(a?.note ?? ''),
      })),
      global,
      annotations,
      sha256: hash,
    }
    fs.mkdirSync(answerDir, { recursive: true })
    fs.writeFileSync(answerFile, JSON.stringify(record, null, 2), 'utf8')
    fs.writeFileSync(textFile, toReplyText(ak.label ?? id, record.answers, global, questions), 'utf8')

    const summary = `赤ペン回答: ${questions.length || answers.length}問 ` +
      `(選択 ${answers.filter((a) => a?.choice).length} / お任せ ${answers.filter((a) => !a?.choice).length}) ` +
      `— ${path.relative(workdir(), answerFile)}`
    const comment = await runKanban(['comment', id, summary, '--author', String(payload?.by ?? 'mobile')])
    let moved = { code: 0, out: '' }
    let status = b.status
    if (b.status === 'blocked') {
      moved = await runKanban(['unblock', id, '--reason', '赤ペン回答を受領'])
      if (moved.code === 0) status = 'ready'
    }
    return {
      ok: comment.code === 0 && moved.code === 0,
      duplicate: false,
      sha256: hash,
      files: { answer: path.relative(workdir(), answerFile), text: path.relative(workdir(), textFile) },
      status,
      moved: status,
      output: `${comment.out}\n${moved.out}`.trim().slice(0, 800),
    }
  }

  /** 反映が違うとき review に戻す。 */
  async function reopen(id, reason) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND', message: 'タスクがありません' }
    const out = await runKanban(['request-changes', id, String(reason || '赤ペンの再確認をお願いします')])
    return { ok: out.code === 0, status: b.status, output: out.out.slice(0, 800) }
  }


  /** 挿絵（workdir/thumbs/... の PNG/JPEG/WebP のみ）。 */
  function thumb(rel) {
    const s = String(rel || '')
    if (!s.startsWith('thumbs/') || !/\.(png|jpe?g|webp)$/i.test(s)) {
      return { ok: false, code: 'BAD_THUMB', message: '挿絵のパスが不正です' }
    }
    const abs = resolveInside(s)
    if (!abs) return { ok: false, code: 'THUMB_MISSING', message: '挿絵が見つかりません' }
    const ext = path.extname(abs).toLowerCase()
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return { ok: true, data: fs.readFileSync(abs), type }
  }


  /** 注釈の下地画像（image= で指定された shots/… の PNG/JPEG）。 */
  function image(id) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND', message: 'タスクがありません' }
    const ak = parseAkapenLine(b.body)
    if (!ak?.image) return { ok: false, code: 'NO_IMAGE', message: 'このタスクには下地画像がありません' }
    const abs = resolveInside(ak.image)
    if (!abs) return { ok: false, code: 'IMAGE_MISSING', message: '下地画像が見つかりません' }
    const ext = path.extname(abs).toLowerCase()
    const type = ext === '.png' ? 'image/png' : 'image/jpeg'
    return { ok: true, data: fs.readFileSync(abs), type, path: abs }
  }

  /** 送信済みの注釈（無ければ null）。 */
  function annotation(id) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND', message: 'タスクがありません' }
    const ak = parseAkapenLine(b.body)
    if (!ak?.image) return { ok: false, code: 'NO_IMAGE', message: '注釈タスクではありません' }
    const rel = ak.image.replace(/\.(png|jpe?g)$/i, '.annotation.json')
    const abs = resolveInside(rel)
    const data = abs ? readJsonIfExists(abs) : null
    if (!data) return { ok: false, code: 'NO_ANNOTATION', message: 'まだ注釈はありません' }
    return { ok: true, data, status: b.status }
  }

  /**
   * 注釈の送信。annotated_image は data URL（JPEG/PNG）。
   * 冪等: 同じ画像（sha256）の再送は duplicate を返し、遷移だけ補完する。
   */
  async function saveAnnotation(id, payload) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND', message: 'タスクがありません' }
    const ak = parseAkapenLine(b.body)
    if (!ak?.image) return { ok: false, code: 'NO_IMAGE', message: 'このタスクには下地画像がありません' }
    if (b.status !== 'blocked') {
      return { ok: false, code: 'NOT_WAITING', status: b.status, message: `注釈待ちではありません（現在: ${b.status}）` }
    }

    const raw = String(payload?.annotated_image || '')
    const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(raw)
    if (!m) return { ok: false, code: 'BAD_IMAGE', message: 'annotated_image は data:image/(png|jpeg);base64,… で送ってください' }
    const buf = Buffer.from(m[2], 'base64')
    const MAX = 12 * 1024 * 1024
    if (buf.length > MAX) return { ok: false, code: 'TOO_LARGE', message: `画像が大きすぎます（${Math.round(buf.length / 1024)}KB > 12MB）` }

    const baseAbs = resolveInside(ak.image)
    if (!baseAbs) return { ok: false, code: 'IMAGE_MISSING', message: '下地画像が見つかりません' }
    const sha = crypto.createHash('sha256').update(buf).digest('hex')
    const baseSha = crypto.createHash('sha256').update(fs.readFileSync(baseAbs)).digest('hex')
    const ext = m[1] === 'image/png' ? '.png' : '.jpg'
    const relAnnotated = ak.image.replace(/\.(png|jpe?g)$/i, `.annotated${ext}`)
    const relJson = ak.image.replace(/\.(png|jpe?g)$/i, '.annotation.json')
    const annotatedAbs = path.join(path.resolve(workdir(), relAnnotated))
    const jsonAbs = path.join(path.resolve(workdir(), relJson))

    const existing = readJsonIfExists(jsonAbs)
    if (existing && existing.image_sha256 === sha) {
      let moved = { code: 0, out: '' }
      let status = b.status
      if (b.status === 'blocked') {
        moved = await runKanban(['unblock', id, '--reason', '注釈を受領（再送）'])
        if (moved.code === 0) status = 'ready'
      }
      return { ok: moved.code === 0, duplicate: true, status, moved: status, sha256: sha }
    }

    const marks = Array.isArray(payload?.marks) ? payload.marks.slice(0, 200) : []
    const note = String(payload?.note ?? '').slice(0, 2000)
    fs.mkdirSync(path.dirname(annotatedAbs), { recursive: true })
    fs.writeFileSync(annotatedAbs, buf)
    const record = {
      task_id: id,
      label: ak.label ?? null,
      round: Number(ak.round ?? 1),
      note,
      marks: marks.map((k) => ({
        tool: String(k?.tool ?? 'pen'),
        points: Array.isArray(k?.points) ? k.points.slice(0, 400) : [],
      })),
      base_image: ak.image,
      annotated_image: relAnnotated,
      base_sha256: baseSha,
      image_sha256: sha,
      annotated_at: new Date().toISOString(),
    }
    fs.writeFileSync(jsonAbs, JSON.stringify(record, null, 2), 'utf8')

    const summary = `注釈: ${marks.length} ストローク${note ? ` / メモ: ${note.slice(0, 60)}` : ''} — ${relAnnotated}`
    const comment = await runKanban(['comment', id, summary, '--author', String(payload?.by ?? 'mobile')])
    let moved = { code: 0, out: '' }
    let status = b.status
    if (b.status === 'blocked') {
      moved = await runKanban(['unblock', id, '--reason', '注釈を受領'])
      if (moved.code === 0) status = 'ready'
    }
    return {
      ok: comment.code === 0 && moved.code === 0,
      duplicate: false,
      sha256: sha,
      files: { annotated: relAnnotated, json: relJson },
      marks: marks.length,
      status,
      moved: status,
      output: `${comment.out}\n${moved.out}`.trim().slice(0, 600),
    }
  }



  /**
   * 注釈の反映先として選べるリポジトリ（Git Ops の repos.json が唯一の一覧）。
   * 自由入力は受けない（存在しないパスへ誤って起票しないため）。
   */
  function targets() {
    const root = path.dirname(cfg.kanbanRoot || path.join(os.homedir(), '.hermes', 'kanban'))
    const cfgPath = path.join(root, 'plugins', 'git-ops', 'config', 'repos.json')
    let data = null
    try {
      data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    } catch {
      return []
    }
    const list = Array.isArray(data) ? data : data?.repos || []
    const out = []
    for (const r of list) {
      const raw = String(r?.path || '')
      if (!raw) continue
      const abs = path.resolve(raw.replace(/^~/, os.homedir()))
      // ホームディレクトリ自体や .git の無いものは候補にしない
      if (abs === os.homedir()) continue
      if (!fs.existsSync(path.join(abs, '.git'))) continue
      out.push({ id: String(r.id || ''), label: String(r.label || r.id || abs), path: abs })
    }
    out.sort((a, b) => (a.id === 'hermes-mobile-pwa' ? -1 : b.id === 'hermes-mobile-pwa' ? 1 : a.label.localeCompare(b.label)))
    return out
  }

  /** target を登録済みリポジトリに解決する（未登録なら null）。 */
  function resolveTarget(raw) {
    const list = targets()
    if (!list.length) return null
    const want = raw ? path.resolve(String(raw).replace(/^~/, os.homedir())) : null
    if (want) return list.find((x) => x.path === want) || null
    return list.find((x) => x.id === 'hermes-mobile-pwa') || list[0]
  }

  /**
   * 反映先パス → Git Ops の登録リポジトリ（**最長一致**）。
   *
   * macOS は大文字小文字を区別しないので比較は小文字で行う（実測: ボードの
   * `target=` は `~/projects/hermes-mobile-pwa` と `~/Projects/hermes-mobile-pwa`
   * が混在している）。`~/.hermes` のような広いリポジトリがあるため、短い一致で
   * 打ち切らず最長一致を採る。
   */
  function repoForTarget(target) {
    const raw = String(target || '')
    if (!raw || !(raw.startsWith('/') || raw.startsWith('~'))) return null
    const abs = path.resolve(raw.replace(/^~/, os.homedir())).toLowerCase()
    let best = null
    for (const t of targets()) {
      const p = t.path.toLowerCase()
      if (abs !== p && !abs.startsWith(p + path.sep)) continue
      if (!best || p.length > best.p.length) best = { id: t.id, label: t.label, p }
    }
    return best ? { id: best.id, label: best.label } : null
  }

  /**
   * 画像 → 反映先リポジトリの手掛かり。
   *
   * 画像そのものにリポジトリ情報は無い（library の名前は取得時刻と slug だけ）。
   * 赤ペンのタスク本文 `[akapen] label=… image=shots/x.png target=<path>` の対応を集め、
   * `image=` の完全一致 → `label=` の前方一致の順で当てる。撮影名は
   * `<label>-<stamp>-<round>.<kind>.png`（実測 33 枚中 27 枚がこれで解決）。
   */
  function imageRepos() {
    const byImage = new Map()
    const byLabel = new Map()
    let db
    try {
      db = openDb()
    } catch {
      return { byImage, labels: [] }
    }
    let rs = []
    try {
      rs = db.prepare("SELECT body FROM tasks WHERE body LIKE '%[akapen]%'").all()
    } catch {
      rs = []
    } finally {
      db.close()
    }
    for (const r of rs) {
      const ak = parseAkapenLine(r.body)
      if (!ak?.target) continue
      if (ak.image) byImage.set(String(ak.image), ak.target)
      if (ak.label) byLabel.set(String(ak.label), ak.target)
    }
    // ラベルは丸ごと一致しないことが多い（`sheet-form` の撮影名に対し
    // タスクは `sheet-form-202611121013`）。ハイフン境界で切った前方部分も候補にする。
    const labels = []
    for (const [label, target] of byLabel) {
      const parts = label.split('-')
      const seen = new Set()
      for (let i = parts.length; i >= 2; i--) {
        const cand = parts.slice(0, i).join('-')
        if (seen.has(cand)) continue
        seen.add(cand)
        labels.push([cand, target])
      }
    }
    labels.sort((a, b) => b[0].length - a[0].length)
    return { byImage, labels }
  }

  /** 撮影名から target を引く（ハイフン境界だけを見る。部分文字列の誤爆を避ける）。 */
  function labelTarget(name, labels) {
    const ext = path.extname(name)
    for (const [label, target] of labels) {
      if (
        name === `${label}${ext}` ||
        name === label ||
        name.startsWith(`${label}-`) ||
        name.startsWith(`${label}.`) ||
        name.includes(`-${label}-`) ||
        name.includes(`-${label}.`)
      ) {
        return target
      }
    }
    return null
  }

  /** 注釈の下地にできる画像（library/** と shots/*.png|jpg、注釈済みは除く）。 */
  function library(limit = 60) {
    const root = workdir()
    const items = []
    const { byImage, labels } = imageRepos()
    const exts = new Set(['.png', '.jpg', '.jpeg', '.webp'])
    const walk = (dir, source) => {
      let ents = []
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of ents) {
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) {
          walk(abs, source || e.name)
          continue
        }
        const ext = path.extname(e.name).toLowerCase()
        if (!exts.has(ext) || /\.(annotated|answer)\./.test(e.name)) continue
        let st
        try {
          st = fs.statSync(abs)
        } catch {
          continue
        }
        const rel = path.relative(root, abs)
        const target = byImage.get(rel) || labelTarget(e.name, labels)
        items.push({
          path: rel,
          source: source || (rel.startsWith('shots') ? 'capture' : 'library'),
          name: e.name,
          bytes: st.size,
          // 取得日時: 一覧の並びもこれ。library への取り込みは copy2 なので
          // 元画像の撮影時刻が残る（実測: chat の取り込み 1746 のファイルが 16:42）
          mtime: Math.round(st.mtimeMs),
          repo: repoForTarget(target), // 分からなければ null（UI は '—'）
          target: target || null,
        })
      }
    }
    walk(path.join(root, 'library'), '')
    walk(path.join(root, 'shots'), 'capture')
    items.sort((a, b) => b.mtime - a.mtime)
    return items.slice(0, limit)
  }

  /**
   * 作業フィード（監視 cron `mobile-akapen-watch` が書く 1 行ログ）。
   *
   * 完了は Discord にしか流れておらず、PWA（と TUI セッション）には届かなかった
   * （実測: 完了 22:26:38 の報告が 22:27:09 に Discord だけへ）。同じ行を
   * `<home>/plugin-data/akapen/feed.jsonl` にも追記し、ここから読んで端末に出す。
   *
   * @param {number} [limit] 末尾から何行読むか（1..200）
   * @param {number} [since] この epoch ms より新しい行だけ返す（0 なら全部）
   * @returns {Array<{at: number, text: string}>} 古い順
   */
  function feed(limit = 20, since = 0) {
    const home = path.dirname(cfg.kanbanRoot || path.join(os.homedir(), '.hermes', 'kanban'))
    const file = path.join(home, 'plugin-data', 'akapen', 'feed.jsonl')
    let raw = ''
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      return [] // まだ 1 行も無い（cron が走っていない）だけなので空でよい
    }
    const tail = raw.split('\n').filter((l) => l.trim()).slice(-Math.min(200, Math.max(1, Number(limit) || 20)))
    const out = []
    for (const line of tail) {
      try {
        const j = JSON.parse(line)
        const at = Date.parse(String(j.at ?? ''))
        if (!Number.isFinite(at)) continue
        if (since && at <= Number(since)) continue
        out.push({ at, text: String(j.text ?? '') })
      } catch {
        // 書きかけ・壊れた行は捨てる（フィードは補助情報）
      }
    }
    return out
  }

  /**
   * ある会話に流す赤ペンの完了報告（監視 cron `mobile-akapen-watch` が書く）。
   *
   * 完了報告は Discord と作業フィードにしか出ておらず、**起票した会話**には戻らなかった
   * （実測: 回答 22:19 → 完了 22:26 の報告を、会話を開いても読めない）。起票時に本文へ
   * `chat=<session_id>` を書いたタスクだけ、完了の 1 行をその会話へ返す。
   *
   * @param {string} sessionId 会話のセッション ID
   * @param {{limit?: number, since?: number}} [opts] 末尾何件・この epoch ms より新しい行だけ
   * @returns {Array<{at: number, taskId: string, label: string|null, text: string}>} 古い順
   */
  function chatReport(sessionId, opts = {}) {
    const id = String(sessionId ?? '').slice(0, 128)
    if (!id) return []
    const home = path.dirname(cfg.kanbanRoot || path.join(os.homedir(), '.hermes', 'kanban'))
    const file = path.join(home, 'plugin-data', 'akapen', 'chat-reports.jsonl')
    let raw = ''
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      return [] // まだ 1 行も無い（宛先の会話が無いタスクしか走っていない）
    }
    const limit = Math.min(Math.max(Number(opts.limit) || 3, 1), 50)
    const since = Number(opts.since) || 0
    const out = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line)
        if (String(j.session_id ?? '') !== id) continue
        const at = Date.parse(String(j.at ?? ''))
        if (!Number.isFinite(at)) continue
        if (since && at <= since) continue
        out.push({ at, taskId: String(j.task_id ?? ''), label: j.label ?? null, text: String(j.text ?? '') })
      } catch {
        // 書きかけ・壊れた行は捨てる（補助情報）
      }
    }
    return out.slice(-limit)
  }

  /** library の画像を返す（allowlist 内のみ）。 */
  function libraryFile(rel) {
    if (!isSafeRel(rel)) return { ok: false, code: 'BAD_PATH', message: 'パスが不正です' }
    const lower = String(rel).toLowerCase()
    if (!(lower.startsWith('library/') || lower.startsWith('shots/'))) {
      return { ok: false, code: 'OUTSIDE', message: 'library / shots 配下のみ配信します' }
    }
    if (!/\.(png|jpe?g|webp)$/.test(lower)) return { ok: false, code: 'BAD_EXT', message: '画像ではありません' }
    const abs = resolveInside(rel)
    if (!abs) return { ok: false, code: 'NOT_FOUND', message: 'ファイルがありません' }
    const ext = path.extname(abs).toLowerCase()
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return { ok: true, data: fs.readFileSync(abs), type }
  }

  const slugOf = (s) =>
    String(s || 'anno')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'anno'

  /**
   * 画像から注釈タスクを1件作る（upload の dataURL / library・shots の既存ファイル）。
   * 成功したら taskId を返すので、PWA はそのまま注釈エディタを開ける。
   */
  async function createFromImage(payload) {
    const source = String(payload?.source || 'upload')
    const title = String(payload?.title || '').slice(0, 120) || '注釈（画像から作成）'
    let buf = null
    let ext = '.png'

    if (source === 'upload') {
      const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(payload?.image || ''))
      if (!m) return { ok: false, code: 'BAD_IMAGE', message: 'image は data:image/(png|jpeg);base64,… で送ってください' }
      buf = Buffer.from(m[2], 'base64')
      ext = m[1] === 'image/png' ? '.png' : '.jpg'
      if (buf.length > 12 * 1024 * 1024) return { ok: false, code: 'TOO_LARGE', message: '画像が大きすぎます（12MB 上限）' }
    } else {
      const rel = String(payload?.path || '')
      if (!isSafeRel(rel)) return { ok: false, code: 'BAD_PATH', message: 'path が不正です' }
      if (!(rel.toLowerCase().startsWith('library/') || rel.toLowerCase().startsWith('shots/'))) {
        return { ok: false, code: 'OUTSIDE', message: 'library / shots 配下の画像だけ使えます' }
      }
      const abs = resolveInside(rel)
      if (!abs) return { ok: false, code: 'NOT_FOUND', message: '画像が見つかりません' }
      buf = fs.readFileSync(abs)
      const e = path.extname(abs).toLowerCase()
      ext = e === '.jpg' || e === '.jpeg' ? '.jpg' : e === '.webp' ? '.webp' : '.png'
    }

    const stamp = new Date()
      .toISOString()
      .slice(0, 16)
      .replace(/[-:T]/g, '')
      .slice(0, 12)
    const label = `${slugOf(payload?.slug || title)}-${stamp}`
    const relShot = `shots/${label}-1${ext}`
    const shotAbs = path.join(path.resolve(workdir(), relShot))
    fs.mkdirSync(path.dirname(shotAbs), { recursive: true })
    fs.writeFileSync(shotAbs, buf)

    // 注釈の反映先は登録済みリポジトリから選ぶ（自由入力は受けない）
    const picked = resolveTarget(payload?.target)
    if (!picked) {
      return {
        ok: false,
        code: 'UNKNOWN_TARGET',
        message: '対象リポジトリは Git Ops に登録済みのものから選んでください',
        targets: targets().map((x) => ({ id: x.id, label: x.label })),
      }
    }
    const target = picked.path
    const body = `[akapen] label=${label} round=1 mode=annotation image=${relShot} target=${target}`
    // assignee が無いと dispatcher が拾わない（実測: ready のまま止まる）
    const created = await runKanban(['create', title, '--body', body, '--assignee', 'mobile'])
    const m = /t_[0-9a-f]{8}/.exec(created.out || '')
    if (created.code !== 0 || !m) {
      return { ok: false, code: 'CREATE_FAILED', message: created.out.slice(0, 300) }
    }
    const taskId = m[0]
    const blocked = await runKanban(['block', taskId, '注釈待ち（画像から作成）', '--kind', 'needs_input'])
    return {
      ok: blocked.code === 0,
      taskId,
      image: relShot,
      label,
      blocked: blocked.code === 0,
      output: blocked.out.slice(0, 300),
    }
  }

  return { board, workdir, list, sheetHtml, sheetData, answer, reopen, sessionId, image, annotation, saveAnnotation, thumb, library, libraryFile, createFromImage, targets, feed, chatReport }
}
