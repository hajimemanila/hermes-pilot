import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { readTailText } from './tail.js'

/**
 * レビュー（review）パイプラインのブリッジ側。
 *
 * 契約は `docs/REVIEW-VIEW.md` と `docs/SPEC-PUBLIC-PLUGIN.md` §4。カンバン（board `mobile`）が唯一の真実で、
 * シートはボードの default_workdir 配下に置かれる。ここは**読み取り + 回答の書き込み**だけを行い、
 * 実装判断はしない（生成も反映も worker の仕事）。
 *
 * パスの解決規則:
 *  - シートの場所はタスク本文の `[review] ... sheet=...` 行から取る（リクエストのパスは使わない）
 *  - 解決後 realpath が workdir 配下でなければ拒否する（allowlist）
 */

/**
 * タスク本文の機械可読行（SPEC §4.1）。
 *
 * 正は `[review]`。移行前のボード（`kanban.db` の `[akapen]` 置換が済んでいない）でも
 * レビューが消えないよう、旧タグも読むだけ受ける（書き込み側は常に `[review]`）。
 */
const LINE_RE = /^\[(?:review|akapen)\]\s+(.+)$/m
const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,40}$/i

/** 旧名（`【赤ペン回答】` / `全体への赤ペン:`）も移行前のシート資産のために受ける。 */
const REPLY_HEAD_RE = /^【(?:レビュー|赤ペン)回答】/
const GLOBAL_LABEL_RE = /^(?:全体への(?:レビュー|赤ペン)|Overall Note):\s*(.*)$/

/** タスク本文から `[review] label=... round=... mode=... sheet=...` を取り出す。 */
export function parseReviewLine(body) {
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

/**
 * シートパスから「設問 JSON」と「回答 JSON」のパスを作る。
 *
 * `mode=sheet`（.html シート）と `mode=standard`（.json シート）の両方で、
 * 回答が**設問ファイルを上書きしない**ようにする。以前は `.html` だけを置換して
 * いたため、`.json` シートでは `replace` が効かず、回答が設問 JSON にそのまま
 * 書き込まれて設問構造が失われていた（実測: p5-fasttrack-01-1.json が回答文に置換）。
 * @param {string} sheetRel `sheets/<label>-<round>.html|.json`
 * @returns {{dataRel: string, answerRel: string}} 設問と回答の相対パス
 */
export function sheetPaths(sheetRel) {
  const rel = String(sheetRel || '')
  const dataRel = rel.replace(/\.html?$/i, '.json')
  const answerRel = dataRel.replace(/\.json$/i, '.answer.json')
  return { dataRel, answerRel }
}

/**
 * 比較用（Before）画像の候補パスを優先順に返す（存在確認はしない純粋関数）。
 *
 * After = いまの下地画像（最新のスクショ）。Before = 前回の赤入れ／前ラウンドの画像。
 * 実測の命名は `<label>-<stamp>-<round>[.<kind>].png`（例 `1385.jpg-202611131208-1.jpg`）で
 * round はほぼ常に 1。比較相手は 3 通りで見つかる:
 *  1. 同名 `.before`（`shots/x-1.before.png` / `x-1.after.png` → `x-1.before.png`）
 *  2. 同じ命名の前ラウンド（末尾の `-<round>` を 1 つ戻す。round >= 2 のときだけ）
 *  3. 同一 label の別タスク（前回のレビュー）の `.annotated`、無ければその元画像
 *
 * 3 は「前ラウンドのタスクは archived のことが多い」（実測）ので status では絞らない。
 *
 * @param {{image?: string, round?: number, others?: Array<{image: string, round?: number}>}} input
 *   `others` は同一 label の他タスクの画像（新しい順）。**このタスク自身は含めない**
 * @returns {string[]} 相対パスの候補（優先順・重複なし）
 */
export function compareCandidates({ image, round = 1, others = [] } = {}) {
  const out = []
  const rel = String(image ?? '').trim()
  if (!rel) return out
  const ext = path.extname(rel)
  if (!/\.(png|jpe?g|webp)$/i.test(ext)) return out
  const noExt = rel.slice(0, -ext.length)
  const push = (p) => {
    if (p && p !== rel && !out.includes(p)) out.push(p)
  }

  // 1) 同名 .before（いまの画像の 1 つ前を撮ったもの）
  push(`${noExt}.before${ext}`)
  if (/\.after$/i.test(noExt)) push(`${noExt.replace(/\.after$/i, '')}.before${ext}`)

  // 2) 前ラウンド（`shots/x-2.png` → `shots/x-1.png`）
  const current = Math.max(1, Number(round) || 1)
  const m = /^(.*-)(\d+)$/.exec(noExt.replace(/\.(after|before)$/i, ''))
  if (m && Number(m[2]) >= 2) {
    const prev = `${m[1]}${Number(m[2]) - 1}`
    push(`${prev}${ext}`)
    push(`${prev}.after${ext}`)
  }

  // 3) 同一 label の前ラウンドタスク（近い順）。赤入れ済みを優先する
  for (const o of Array.isArray(others) ? others : []) {
    const r = String(o?.image ?? '').trim()
    if (!r) continue
    if (Number(o?.round ?? 1) > current) continue
    const e = path.extname(r)
    const base = r.slice(0, -e.length)
    push(`${base}.annotated${e}`)
    push(r)
  }
  return out
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

/**
 * 回答テキストを構造化する（シートが直接送ってきた場合に使う）。
 *
 * EN 見出し（`[Review Answer]` / `Overall Note:`）と JA 見出しの両方、および旧
 * `【赤ペン回答】` / `全体への赤ペン:` を受理する（SPEC §4.1）。
 */
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
    const g = GLOBAL_LABEL_RE.exec(line)
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

/**
 * 回答を貼り戻し用テキストにする（`parseReplyText` と往復できる形）。
 *
 * @param {string} label ラベル
 * @param {Array<{id: string, choice: string|null, note?: string}>} answers 回答
 * @param {string} global 全体コメント
 * @param {Array<{id: string, text?: string}>} [questions] 設問（見出しに使う）
 * @param {'ja'|'en'} [lang] 見出しの言語（既定は日本語）
 */
export function toReplyText(label, answers, global, questions = [], lang = 'ja') {
  const title = new Map(questions.map((q) => [String(q.id), String(q.text ?? '')]))
  const en = lang === 'en'
  const lines = [en ? `[Review Answer] ${label}` : `【レビュー回答】${label}`]
  for (const a of answers) {
    const q = title.get(String(a.id)) || String(a.id)
    const choice = a.choice === null || a.choice === undefined ? '(未選択 = お任せ)' : String(a.choice)
    const note = a.note ? ` / 補足: ${String(a.note).replace(/\n/g, ' ')}` : ''
    lines.push(`Q${String(a.id).replace(/^q/i, '')}. ${q}: ${choice}${note}`)
  }
  lines.push(`${en ? 'Overall Note' : '全体へのレビュー'}: ${String(global ?? '').replace(/\r/g, '')}`)
  lines.push('---')
  lines.push('上の回答を反映して作業を続けてください。お任せの項目は推奨案で確定してください。')
  return `${lines.join('\n')}\n`
}

/**
 * HTML のテキストとして安全な文字列にする（`&` `<` `>` `"` `'`）。
 *
 * JSON シート（外部から来る `title` / 設問文 / 選択肢）を HTML に埋め込む前に必ず通す。
 * `&` を最初に置換しないと二重エスケープになるので順序は固定。
 *
 * @param {unknown} value 任意の値
 * @returns {string} エスケープ済み文字列
 */
export function escapeHtmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 選択肢が推奨か（生成 HTML のバッジ用）。
 *
 * シートを作る側は `recommended: true` を付けるが、既存資産にはラベルに「推奨」と
 * 書いただけのものがある。否定（「非推奨」「not recommended」）を先に落とす。
 *
 * @param {{id?: string, label?: string, detail?: string, recommended?: boolean|string}} option 選択肢
 * @returns {boolean} 推奨か
 */
function isRecommendedDataOption(option) {
  if (option?.recommended === true || option?.recommended === 'true') return true
  const text = `${option?.label ?? ''} ${option?.detail ?? ''}`
  if (/非推奨|not\s+recommended/i.test(text)) return false
  return /推奨|recommend/i.test(text)
}

/**
 * `sheet.json` からスタンドアロンな閲覧用 HTML を組み立てる（SPEC-PILOT-V8 §3.1 / D38）。
 *
 * 手書き `.html` が無いシートでも「シート全体を開く ↗」を成立させるためのフォールバック。
 * 回答はアプリのドロワー（`<StandardForm>`）で行う前提なので、ここは**閲覧ビュー**にして
 * 送信フォームは置かない（`.json` だけで完結する JSON ファースト運用の受け皿）。
 *
 * @param {object} data `sheet.json`（`{title, topic, questions:[{id,text,options}]}`）
 * @param {{label?: string, round?: number|string, target?: string}} [ak] レビュー行の情報
 * @returns {string} `<!DOCTYPE html>` で始まる完全な HTML
 */
export function renderSheetHtmlFromData(data, ak = {}) {
  const esc = escapeHtmlText
  const title = esc(data?.title ?? ak?.title ?? ak?.label ?? 'Review')
  const label = esc(ak?.label ?? data?.label ?? '')
  const topic = esc(data?.topic ?? '')
  const round = Number(ak?.round ?? data?.round ?? 1) || 1
  const target = esc(ak?.target ?? '')
  const questions = Array.isArray(data?.questions) ? data.questions : []

  const sections = questions.map((q, i) => {
    const qtext = esc(q?.text ?? q?.question ?? '')
    const options = Array.isArray(q?.options) ? q.options : []
    const items = options.map((o) => {
      const rec = isRecommendedDataOption(o)
      const detail = esc(o?.detail ?? o?.note ?? '')
      return [
        `        <li class="opt${rec ? ' rec' : ''}">`,
        `          <span class="oid">${esc(o?.id ?? '')}</span>`,
        `          <span class="olabel">${esc(o?.label ?? '')}${rec ? '<span class="rec-badge">推奨</span>' : ''}</span>`,
        detail ? `          <span class="odetail">${detail}</span>` : '',
        '        </li>',
      ]
        .filter(Boolean)
        .join('\n')
    })
    return [
      '      <section class="q">',
      `        <h3>Q${i + 1}. ${qtext}</h3>`,
      items.length ? `        <ul class="opts">\n${items.join('\n')}\n        </ul>` : '',
      '      </section>',
    ]
      .filter(Boolean)
      .join('\n')
  })

  const meta = [
    label ? `<span class="meta-label">${label}</span>` : '',
    `<span class="meta-round">r${esc(round)}</span>`,
    target ? `<span class="meta-target">${target}</span>` : '',
  ]
    .filter(Boolean)
    .join('')

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;padding:16px 14px 40px;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;
    background:#f6f6f4;color:#1c1c1e}
  main{max-width:720px;margin:0 auto}
  h1{font-size:19px;line-height:1.45;margin:0 0 6px}
  .meta{display:flex;flex-wrap:wrap;gap:8px;font-size:12px;color:#5c5c66;margin:0 0 14px}
  .meta span{padding:2px 8px;border-radius:999px;background:#e8e8e4}
  .note{font-size:13px;line-height:1.6;color:#3a3a40;background:#fff;border:1px solid #dedcd4;
    border-radius:12px;padding:10px 12px;margin:0 0 18px}
  .topic{font-size:14px;line-height:1.7;white-space:pre-wrap;background:#fff;border:1px solid #dedcd4;
    border-radius:12px;padding:12px;margin:0 0 18px}
  .q{background:#fff;border:1px solid #dedcd4;border-radius:14px;padding:14px;margin:0 0 14px}
  .q h3{font-size:15px;line-height:1.6;margin:0 0 10px}
  .opts{list-style:none;margin:0;padding:0}
  .opt{display:flex;flex-wrap:wrap;gap:6px 10px;padding:9px 10px;border-radius:10px;border:1px solid #e6e4dc}
  .opt + .opt{margin-top:8px}
  .opt.rec{border-color:#1f9d63;background:#f2fbf6}
  .oid{min-width:1.4em;font-weight:700}
  .olabel{font-weight:600}
  .odetail{flex-basis:100%;font-size:13px;color:#5c5c66}
  .rec-badge{margin-left:8px;font-size:11px;font-weight:700;color:#0b5f45;background:#d6f5e6;
    border-radius:999px;padding:1px 7px;vertical-align:1px}
  .empty{font-size:14px;color:#5c5c66}
  @media (prefers-color-scheme:dark){
    body{background:#131315;color:#f2f2f4}
    .meta{color:#a0a0aa} .meta span{background:#242428}
    .q,.note,.topic{background:#1c1c1f;border-color:#2e2e33}
    .opt{border-color:#2e2e33} .opt.rec{border-color:#2f9d6b;background:#152b21}
    .odetail{color:#a0a0aa} .note{color:#d8d8de}
  }
</style>
</head>
<body>
<main id="akForm">
  <h1>${title}</h1>
  <div class="meta">${meta}</div>
  <p class="note">このシートは <code>sheet.json</code> から自動生成した閲覧ビューです。回答はアプリのレビュータブ（簡易回答フォーム）から送ってください。</p>
${topic ? `  <div class="topic">${topic}</div>` : ''}
${sections.length ? sections.join('\n') : '  <p class="empty">設問がありません。</p>'}
</main>
</body>
</html>
`
}

/**
 * レビューシートの CSP（D57）。**条件分岐しない**。
 *
 * `sandbox allow-scripts allow-forms` を付けると、シートは不透明オリジンに落ちる。
 * シートに同居するスクリプト（設問の描画・回答テキストの生成）は動くが、
 * same-origin Cookie も `/ws/term` も `/api/*` も触れない。回答は postMessage で
 * 親（PWA の iframe / `/api/review/:id/view` ラッパー）へ渡し、親が POST する。
 *
 * 以前は `sec-fetch-dest` を見て単体タブだけ same-origin を許していたが、
 * 「ヘッダを付け替えれば same-origin に戻せる」抜け道になるので廃止した。
 * 単体タブで開きたい場合は `/api/review/:id/view` を使う。
 */
export const REVIEW_SHEET_CSP =
  "sandbox allow-scripts allow-forms; default-src 'none'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; script-src 'unsafe-inline'; font-src data:"

/** `/api/review/:id/sheet` のレスポンスヘッダ（常に sandbox）。 */
export function reviewSheetHeaders() {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': REVIEW_SHEET_CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
}

/**
 * `/api/review/:id/view` ラッパー自身の CSP。
 *
 * ラッパーはブリッジが生成する最小 HTML なので same-origin を許可する必要がある
 * （回答の POST と sheet の iframe 読み込みだけ）。`sandbox` は付けない —
 * 付けると `allow-same-origin` 抜きでは fetch が不透明オリジン扱いになる。
 */
export const REVIEW_VIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "frame-src 'self'; connect-src 'self'; img-src data:"

/** `/api/review/:id/view` のレスポンスヘッダ。 */
export function reviewViewHeaders() {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': REVIEW_VIEW_CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
}

/** JSON を `<script>` の中へ安全に埋める（`</script>` での脱出を潰す）。 */
function scriptJson(value) {
  return JSON.stringify(String(value)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
}

/**
 * 単体タブ用のラッパー HTML（D57）。
 *
 * `/api/review/:id/sheet` は常に sandbox なので、シート単体では回答を POST できない。
 * このラッパーが same-origin の親として sandbox `<iframe>` を抱え、
 * シートからの `postMessage` を `POST /api/review/:id/answer` へ中継する。
 *
 * @param {string} taskId タスク id
 * @returns {string} HTML
 */
export function reviewViewHtml(taskId) {
  const id = String(taskId)
  const jsTask = scriptJson(id)
  const jsSrc = scriptJson(`/api/review/${encodeURIComponent(id)}/sheet`)
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>レビューシート ${escapeHtmlText(id)}</title>
<style>
html,body{margin:0;height:100%;background:#f6f4ef;color:#1b1a17;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif}
#akViewSheet{display:block;width:100%;height:100%;border:0;background:#f6f4ef}
#akViewStatus{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:9;display:none;padding:10px 12px;border-radius:12px;font-size:13px;line-height:1.6;box-shadow:0 6px 20px rgba(0,0,0,.16)}
#akViewStatus.show{display:block}
#akViewStatus.ok{background:#e7f8f1;color:#0b5f45}
#akViewStatus.ng{background:#fdecea;color:#8a1f17}
</style>
</head>
<body>
<iframe id="akViewSheet" src="${escapeHtmlText(`/api/review/${encodeURIComponent(id)}/sheet`)}" sandbox="allow-scripts allow-forms" title="レビューシート"></iframe>
<div id="akViewStatus" role="status" aria-live="polite"></div>
<script>
(function () {
  var TASK = ${jsTask};
  var SHEET = ${jsSrc};
  var box = document.getElementById('akViewStatus');
  var timer = 0;
  function note(ok, msg) {
    box.textContent = msg;
    box.className = 'show ' + (ok ? 'ok' : 'ng');
    clearTimeout(timer);
    // 成功は控えめに消す。失敗は読ませたいので残す。
    if (ok) timer = setTimeout(function () { box.className = ''; }, 4000);
  }
  function title(el) {
    return (el && ((el.error && el.error.message) || el.message)) || 'unknown';
  }
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d) return;
    // 旧シート（akapen:reply）も受ける。新しい注入スクリプトは review:reply を送る。
    if (d.type !== 'review:reply' && d.type !== 'akapen:reply') return;
    if (String(d.taskId) !== TASK) return;
    var text = String(d.text || '');
    if (!text) return;
    note(true, '送信中…');
    fetch('/api/review/' + encodeURIComponent(TASK) + '/answer', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-client': 'mobile' },
      body: JSON.stringify({ text: text, by: 'web' })
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: r.ok, j: null }; });
    }).then(function (res) {
      var ok = Boolean(res.ok && res.j && res.j.ok);
      note(ok, ok ? '回答を送信しました（タスクは ' + (res.j.moved || '—') + '）' : '送信できませんでした: ' + title(res.j));
    }).catch(function (e) {
      note(false, '送信エラー: ' + (e && e.message ? e.message : e));
    });
  });
  // シートが読めなかったとき（404 など）に無言の白画面を出さない
  var frame = document.getElementById('akViewSheet');
  if (frame) frame.addEventListener('error', function () { note(false, 'シートを読み込めません: ' + SHEET); });
})();
</script>
</body>
</html>
`
}

/**
 * シート HTML に「回答をアプリへ送る」小さなブリッジを注入する（保存物は書き換えない）。
 *
 * アプリ内で開いたときだけ、設問見出し (Q1…) をマーカーで装飾する（レビュー注釈の指摘）。
 * 保存済みのシート（file:// で開く原本）は書き換えないので、装飾はアプリ表示の担当。
 */
export function injectReviewBridge(html, taskId) {
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
    // 移行前のシートは【赤ペン回答】を、新しいシートは【レビュー回答】を出す。
    if (!text || !/【(?:レビュー|赤ペン)回答】|\[Review Answer\]/.test(text)) return;
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'review:reply', taskId: TASK, text: text }, '*');
      report(true, 'アプリに回答を送りました（この画面は閉じてOK）');
      return;
    }
    // シートは常に sandbox（不透明オリジン）で配信されるので、自分では API を叩けない。
    // 回答は必ず親（PWA の iframe / /api/review/:id/view ラッパー）へ postMessage する。
    report(
      false,
      'この画面からは直接送信できません。アプリのレビュータブ、または /api/review/' +
        TASK +
        '/view から開いてください'
    );
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
  window.__reviewSubmit = submit;
  // 互換エイリアス: 移行前のシート資産はこちらを直接呼ぶ（SPEC §4.1）
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
export function createReview(cfg, opts = {}) {
  const board = opts.board || process.env.REVIEW_BOARD || 'mobile'
  const boardDir = path.join(cfg.kanbanRoot, 'boards', board)
  const dbPath = path.join(boardDir, 'kanban.db')

  function homeDir() {
    return path.dirname(cfg.kanbanRoot || path.join(os.homedir(), '.hermes', 'kanban'))
  }

  /**
   * データの根（D1 / §3.2）。`~/.hermes/plugin-data/hermes-pilot/` に一本化する。
   * 旧 `plugin-data/akapen` や `~/Projects/akapen` は参照しない（移行スクリプトが物理コピーする）。
   */
  function dataRoot() {
    if (cfg.pluginDataDir) return cfg.pluginDataDir
    return path.join(homeDir(), 'plugin-data', 'hermes-pilot')
  }

  /** レビューのワークスペース（sheets / shots / library / *.jsonl）。 */
  function reviewRoot() {
    return path.join(dataRoot(), 'review')
  }

  function sanitizeChatId(raw) {
    return String(raw ?? '')
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 128)
  }

  function taskChatsFile() {
    return path.join(reviewRoot(), 'task-chats.json')
  }

  function readTaskChats() {
    const obj = readJsonIfExists(taskChatsFile())
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      const c = sanitizeChatId(v)
      if (k && c) out[k] = c
    }
    return out
  }

  function rememberTaskChat(taskId, rawChat) {
    const id = String(taskId ?? '').trim()
    const chat = sanitizeChatId(rawChat)
    if (!id || !chat) return
    try {
      const file = taskChatsFile()
      const cur = readTaskChats()
      cur[id] = chat
      const keys = Object.keys(cur)
      if (keys.length > 500) {
        for (const k of keys.slice(0, keys.length - 500)) delete cur[k]
      }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(cur, null, 2), 'utf8')
    } catch {
      /* 補助情報なので失敗しても本処理を止めない */
    }
  }

  /** ボードの default_workdir（シート置き場のルート）。未設定なら review ワークスペース。 */
  function workdir() {
    if (opts.root) return path.resolve(opts.root.replace(/^~/, os.homedir()))
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(boardDir, 'board.json'), 'utf8'))
      if (meta.default_workdir) return path.resolve(String(meta.default_workdir).replace(/^~/, os.homedir()))
    } catch {
      /* fall through */
    }
    return reviewRoot()
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
      // assignee も取る（回答後に担当を付けるかの判定に使う・§3.1）
      return db.prepare('SELECT body, status, title, assignee FROM tasks WHERE id = ?').get(id) || null
    } catch {
      return null
    } finally {
      db.close()
    }
  }

  /**
   * 同一 label の他タスク（前ラウンド）を 1 回のクエリで索引にする（比較画像の解決用）。
   *
   * 前ラウンドのタスクは `archived` のことが多い（実測: `1379.jpg-…` の前回は archived）ので
   * status では絞らない。キーは `[review]` 行の label、値は新しい順の `{id, image, round, createdAt}`。
   *
   * @returns {Map<string, Array<{id: string, image: string, round: number, createdAt: number}>>}
   */
  function siblingIndex() {
    const byLabel = new Map()
    let db
    try {
      db = openDb()
    } catch {
      return byLabel
    }
    try {
      const rs = db.prepare("SELECT id, body, created_at FROM tasks WHERE body LIKE '%[review]%'").all()
      for (const r of rs) {
        const ak = parseReviewLine(r.body)
        if (!ak?.image || !ak.label) continue
        const list = byLabel.get(ak.label) || []
        list.push({
          id: r.id,
          image: ak.image,
          round: Number(ak.round ?? 1),
          createdAt: Number(r.created_at ?? 0) * 1000,
        })
        byLabel.set(ak.label, list)
      }
    } catch {
      /* 索引は補助情報。壊れた DB でも一覧は返す */
    } finally {
      db.close()
    }
    for (const list of byLabel.values()) list.sort((a, b) => b.createdAt - a.createdAt)
    return byLabel
  }

  /**
   * 比較用（Before）画像の実在する相対パス（無ければ null）。
   *
   * @param {string} id タスク ID（自分自身を候補から外す）
   * @param {object} ak `[review]` 行
   * @param {Map} [index] `siblingIndex()` の結果（一覧では 1 回だけ作って渡す）
   */
  function compareRelOf(id, ak, index) {
    if (!ak?.image) return null
    const others = (index?.get(ak.label) || []).filter((o) => o.id !== id)
    const cands = compareCandidates({ image: ak.image, round: Number(ak.round ?? 1), others })
    for (const rel of cands) {
      if (resolveInside(rel)) return rel
    }
    return null
  }

  /**
   * このタスクを実行している worker のセッション ID（無ければ null）。
   *
   * `session_id` がタスク行にあっても `db`（どのプロファイルの state.db か）は
   * イベントにしか残らないので、必ず `task_events` も読んで補完する。
   */
  function sessionId(id) {
    let db
    try {
      db = openDb()
    } catch {
      return null
    }
    try {
      const r = db.prepare('SELECT session_id, status FROM tasks WHERE id = ?').get(id)
      const fromRow = r?.session_id ? String(r.session_id) : null
      const evs = db
        .prepare(
          "SELECT payload FROM task_events WHERE task_id = ? AND kind IN ('owner_admitted','worker_bound','spawned') ORDER BY id DESC LIMIT 6",
        )
        .all(id)
      let sid = fromRow
      let evDb = null
      for (const ev of evs) {
        try {
          const p = JSON.parse(ev.payload || '{}')
          if (!sid && p.session_id) sid = String(p.session_id)
          if (!evDb && p.db) evDb = String(p.db)
          if (sid && evDb) break
        } catch {
          /* 壊れた payload は無視 */
        }
      }
      if (!sid) return null
      return { sessionId: sid, status: r?.status ?? null, db: evDb }
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

  /** 一覧（PWA のレビュータブ）。 */
  function list(limit = 80) {
    const out = []
    const base = rows(limit)
    const events = lastEvents(base.map((r) => r.id))
    const taskChats = readTaskChats()
    const siblings = siblingIndex()
    for (const r of base) {
      const ak = parseReviewLine(r.body)
      if (!ak) continue
      const sheetAbs = ak.sheet ? resolveInside(ak.sheet) : null
      const paths = ak.sheet ? sheetPaths(ak.sheet) : null
      const dataRel = paths ? paths.dataRel : null
      const dataAbs = dataRel ? resolveInside(dataRel) : null
      const sheet = dataAbs ? readJsonIfExists(dataAbs) : null
      const answerRel = paths ? paths.answerRel : null
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
        review: {
          label: ak.label ?? null,
          image: ak.image ?? null,
          // 比較用（Before=前回の赤入れ）画像があるか。UI はこれでトグルを出す
          hasCompare: Boolean(compareRelOf(r.id, ak, siblings)),
          target: ak.target ?? null,
          repo: repoForTarget(ak.target),
          chat: sanitizeChatId(ak.chat) || taskChats[r.id] || null,
          mode: ak.mode ?? 'standard',
          round: Number(ak.round ?? 1),
          sheet: ak.sheet ?? null,
          exists: Boolean(sheetAbs || dataAbs),
          title: sheet?.title ?? null,
          topic: sheet?.topic ?? null,
          questions: Array.isArray(sheet?.questions) ? sheet.questions.length : 0,
          answeredAt: answered?.answered_at ?? null,
        },
      })
    }
    return out
  }

  /**
   * シート HTML（認可は呼び出し側）。
   *
   * `.html` があればそれをそのまま返す（後方互換）。無い（または `.json` を指している）
   * ときは同じ場所の `.json` から閲覧用 HTML を動的生成して返す — JSON ファーストで
   * 起票されたシートでも「シート全体を開く ↗」が常に動くようにするため（D38）。
   */
  function sheetHtml(id) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const ak = parseReviewLine(b.body)
    if (!ak?.sheet) return { ok: false, code: 'NO_SHEET' }
    const abs = resolveInside(ak.sheet)
    const isJson = Boolean(abs && /\.json$/i.test(abs))
    if (abs && !isJson) return { ok: true, html: fs.readFileSync(abs, 'utf8'), path: abs }
    const dataAbs = isJson ? abs : resolveInside(sheetPaths(ak.sheet).dataRel)
    const data = dataAbs ? readJsonIfExists(dataAbs) : null
    if (!data) return { ok: false, code: 'SHEET_MISSING' }
    return { ok: true, html: renderSheetHtmlFromData(data, ak), path: dataAbs, generated: true }
  }

  /** シートの構造化データ（PWA のネイティブフォーム用）。 */
  function sheetData(id) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const ak = parseReviewLine(b.body)
    if (!ak?.sheet) return { ok: false, code: 'NO_SHEET' }
    const abs = resolveInside(sheetPaths(ak.sheet).dataRel)
    const data = abs ? readJsonIfExists(abs) : null
    if (!data) return { ok: false, code: 'DATA_MISSING' }
    // 回答の履歴（完了した項目を「なぜこの設計か」まで辿れるようにする）。
    // 回答は無いことがある（回答前に片付けた等）ので、無ければ null。
    const answer = readJsonIfExists(resolveInside(sheetPaths(ak.sheet).answerRel) || '\0')
    return { ok: true, data, answer: answer || null, taskId: id, status: b.status }
  }

  /**
   * 回答後にタスクへ付ける担当プロファイル。
   * 未指定なら `HP_REVIEW_ASSIGNEE` → `opts.assignee` → `'mobile'`。
   * @returns {string} プロファイル名
   */
  const reviewAssignee = () =>
    String(process.env.HP_REVIEW_ASSIGNEE ?? opts.assignee ?? '').trim() || 'mobile'

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
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const ak = parseReviewLine(b.body)
    if (!ak?.sheet) return { ok: false, code: 'NO_SHEET' }

    const sheetAbs = resolveInside(ak.sheet)
    const dataAbs = resolveInside(ak.sheet.replace(/\.html$/, '.json'))
    const data = dataAbs ? readJsonIfExists(dataAbs) : null
    const questions = Array.isArray(data?.questions) ? data.questions : []

    // シート HTML がそのまま送ってきた【レビュー回答】も受ける
    const fromText =
      payload?.text && !(Array.isArray(payload?.answers) && payload.answers.length)
        ? parseReplyText(payload.text)
        : null
    const answers = fromText ? fromText.answers : Array.isArray(payload?.answers) ? payload.answers : []
    const global = fromText ? fromText.global : String(payload?.global ?? '')
    const annotations = Array.isArray(payload?.annotations) ? payload.annotations : []
    const hash = answerHash({ answers, global, annotations })

    const answerRel = sheetPaths(ak.sheet).answerRel
    const answerDir = path.dirname(path.resolve(workdir(), answerRel))
    const answerFile = path.join(answerDir, path.basename(answerRel))
    const textFile = answerFile.replace(/\.answer\.json$/, '.answer.txt')

    if (payload?.chat) rememberTaskChat(id, payload.chat)
    const existing = readJsonIfExists(answerFile)
    if (existing && existing.sha256 === hash) {
      // 回答は保存済み。遷移だけ未了なら（再送で）ここで進める — 冪等の本体はこの分岐
      let moved = { code: 0, out: '' }
      let status = b.status
      if (b.status === 'blocked') {
        moved = await runKanban(['unblock', id, '--reason', 'レビュー回答を受領（再送）'])
        if (moved.code === 0) status = 'ready'
      }
      return {
        ok: moved.code === 0,
        duplicate: true,
        sha256: hash,
        status,
        moved: status,
        code: 'REVIEW_ALREADY_ANSWERED',
        output: moved.out.slice(0, 400),
      }
    }
    // 回答は「レビュー待ち（blocked）」のときだけ受け付ける。ready / running / review / done へ
    // 送ると answer.json を上書きし、comment が二重に付く（レビューシートの付録 1-2）。
    if (b.status !== 'blocked') {
      return {
        ok: false,
        code: 'NOT_WAITING',
        status: b.status,
        params: { status: b.status },
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

    const summary = `レビュー回答: ${questions.length || answers.length}問 ` +
      `(選択 ${answers.filter((a) => a?.choice).length} / お任せ ${answers.filter((a) => !a?.choice).length}) ` +
      `— ${path.relative(workdir(), answerFile)}`
    const comment = await runKanban(['comment', id, summary, '--author', String(payload?.by ?? 'mobile')])
    let moved = { code: 0, out: '' }
    let status = b.status
    if (b.status === 'blocked') {
      moved = await runKanban(['unblock', id, '--reason', 'レビュー回答を受領'])
      if (moved.code === 0) status = 'ready'
    }
    /*
     * 回答を受けたタスクに担当が無いと、ready になっても**誰も走らない**
     * （「回答済みだが自律ワーカー起動待ち」で止まる・実測）。未割当ならここで付ける。
     */
    let assigned = null
    if (status === 'ready' && !String(b.assignee ?? '').trim()) {
      const who = String(reviewAssignee() ?? '').trim()
      if (who) {
        const r = await runKanban(['assign', id, who])
        if (r.code === 0) {
          assigned = who
          moved = { code: 0, out: `${moved.out}\n${r.out}`.trim() }
        }
      }
    }
    return {
      ok: comment.code === 0 && moved.code === 0,
      duplicate: false,
      assigned,
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
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const out = await runKanban(['request-changes', id, String(reason || 'レビューの再確認をお願いします')])
    return { ok: out.code === 0, status: b.status, output: out.out.slice(0, 800) }
  }

  /**
   * 検収（1 タップ合格）の状態遷移。
   *
   * 「✅ Looks Good」の意味は **合格＝完了**（SPEC §5.2.3 / D15②）。まず `complete` を試し、
   * それが通らない（ワーカーが抱えたまま等）ときだけ `unblock` に落とす — どちらでも
   * ワーカーは止まらず、人間の判断は失われない。
   *
   * @param {string} id タスク ID
   * @param {{status: string}} b `bodyOf()` の行
   * @param {string} reason unblock に落ちたときの理由
   * @returns {Promise<{code: number, out: string, status: string, moved: string|null}>}
   */
  async function approveAdvance(id, b, reason) {
    if (b.status !== 'blocked') return { code: 0, out: '', status: b.status, moved: null }
    const done = await runKanban([
      'complete',
      id,
      '--result',
      'Visual check passed',
      '--metadata',
      JSON.stringify({ closed_from: 'review', approved_by: 'mobile', approved_at: new Date().toISOString() }),
    ])
    if (done.code === 0) return { code: 0, out: done.out, status: 'done', moved: 'done' }
    const freed = await runKanban(['unblock', id, '--reason', reason])
    return {
      code: freed.code,
      out: `${done.out}\n${freed.out}`,
      status: freed.code === 0 ? 'ready' : b.status,
      moved: freed.code === 0 ? 'ready' : null,
    }
  }

  /**
   * 赤入れせずに 1 タップ検収（SPEC §5.2.3 / D15②）。
   *
   * `answer()` と同じ方針:
   *  - 注釈待ち（blocked）のときだけ受け付ける（それ以外は NOT_WAITING）
   *  - 同じ検収の再送は `duplicate` を返し、コメントを二重に付けず遷移だけ補完する
   *
   * 記録は `<image>.approval.json`（注釈の `.annotation.json` と同じ場所）。
   *
   * @param {string} id タスク ID
   * @param {{note?: string, by?: string, chat?: string}} [payload]
   */
  async function approve(id, payload = {}) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const ak = parseReviewLine(b.body)
    if (!ak?.image) return { ok: false, code: 'NO_IMAGE' }
    if (payload?.chat) rememberTaskChat(id, payload.chat)

    const note = String(payload?.note ?? '').slice(0, 400)
    const by = String(payload?.by ?? 'mobile').slice(0, 40)
    const rel = ak.image.replace(/\.(png|jpe?g|webp)$/i, '.approval.json')
    const abs = path.join(path.resolve(workdir(), rel))
    const reason = `検収 OK（Visual check passed）${note ? `: ${note}` : ''}`

    const existing = readJsonIfExists(abs)
    if (existing) {
      // 冪等: 記録済みならコメントは増やさない（遷移だけ補完）
      const adv = await approveAdvance(id, b, `${reason}（再送）`)
      return {
        ok: adv.code === 0,
        duplicate: true,
        status: adv.status,
        moved: adv.moved,
        files: { approval: rel },
        code: 'APPROVAL_ALREADY_RECORDED',
        output: adv.out.slice(0, 400),
      }
    }
    if (b.status !== 'blocked') {
      return {
        ok: false,
        code: 'NOT_WAITING',
        status: b.status,
        params: { status: b.status },
      }
    }

    const record = {
      task_id: id,
      label: ak.label ?? null,
      round: Number(ak.round ?? 1),
      image: ak.image,
      note,
      approved_by: by,
      approved_at: new Date().toISOString(),
      verdict: 'visual-check-passed',
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, JSON.stringify(record, null, 2), 'utf8')

    const comment = await runKanban(['comment', id, 'Visual check passed', '--author', by])
    if (comment.code !== 0) {
      // コメントが残せなかったら検収の記録も消す（再挑戦でコメントを落とさないため）
      try {
        fs.unlinkSync(abs)
      } catch {
        /* 既に消えていれば noop */
      }
      return {
        ok: false,
        code: 'COMMENT_FAILED',
        status: b.status,
        moved: null,
        output: comment.out.slice(0, 400),
      }
    }
    const adv = await approveAdvance(id, b, reason)
    return {
      ok: adv.code === 0,
      duplicate: false,
      status: adv.status,
      moved: adv.moved,
      files: { approval: rel },
      output: `${comment.out}\n${adv.out}`.trim().slice(0, 600),
    }
  }


  /** 挿絵（workdir/thumbs/... の PNG/JPEG/WebP のみ）。 */
  function thumb(rel) {
    const s = String(rel || '')
    if (!s.startsWith('thumbs/') || !/\.(png|jpe?g|webp)$/i.test(s)) {
      return { ok: false, code: 'BAD_THUMB' }
    }
    const abs = resolveInside(s)
    if (!abs) return { ok: false, code: 'THUMB_MISSING' }
    const ext = path.extname(abs).toLowerCase()
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return { ok: true, data: fs.readFileSync(abs), type }
  }


  /** 注釈の下地画像（annotated=true なら赤入れ済み、compare=true なら前回の赤入れ）。 */
  function image(id, opts = {}) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const ak = parseReviewLine(b.body)
    if (!ak?.image) return { ok: false, code: 'NO_IMAGE' }
    let rel = ak.image
    if (opts?.compare) {
      // 比較（Before）: 前回の赤入れ／前ラウンドの画像。無ければ 404 で UI がトグルを隠す
      const cmp = compareRelOf(id, ak, siblingIndex())
      if (!cmp) return { ok: false, code: 'NO_COMPARE' }
      rel = cmp
    } else if (opts?.annotated) {
      const jsonAbs = resolveInside(ak.image.replace(/\.(png|jpe?g)$/i, '.annotation.json'))
      const data = jsonAbs ? readJsonIfExists(jsonAbs) : null
      if (data?.annotated_image) rel = data.annotated_image
    }
    const abs = resolveInside(rel)
    if (!abs) return { ok: false, code: 'IMAGE_MISSING' }
    const ext = path.extname(abs).toLowerCase()
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return { ok: true, data: fs.readFileSync(abs), type, path: abs, rel }
  }

  /** 送信済みの注釈（無ければ null）。 */
  function annotation(id) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const ak = parseReviewLine(b.body)
    if (!ak?.image) return { ok: false, code: 'NO_IMAGE' }
    const rel = ak.image.replace(/\.(png|jpe?g)$/i, '.annotation.json')
    const abs = resolveInside(rel)
    const data = abs ? readJsonIfExists(abs) : null
    if (!data) return { ok: false, code: 'NO_ANNOTATION' }
    return { ok: true, data, status: b.status }
  }

  /**
   * 注釈の送信。annotated_image は data URL（JPEG/PNG）。
   * 冪等: 同じ画像（sha256）の再送は duplicate を返し、遷移だけ補完する。
   */
  async function saveAnnotation(id, payload) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const ak = parseReviewLine(b.body)
    if (!ak?.image) return { ok: false, code: 'NO_IMAGE' }
    if (b.status !== 'blocked') {
      return { ok: false, code: 'NOT_WAITING', status: b.status, params: { status: b.status } }
    }
    if (payload?.chat) rememberTaskChat(id, payload.chat)

    const raw = String(payload?.annotated_image || '')
    const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(raw)
    if (!m) return { ok: false, code: 'BAD_IMAGE' }
    const buf = Buffer.from(m[2], 'base64')
    const MAX = 12 * 1024 * 1024
    if (buf.length > MAX) return { ok: false, code: 'TOO_LARGE' }

    const baseAbs = resolveInside(ak.image)
    if (!baseAbs) return { ok: false, code: 'IMAGE_MISSING' }
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
   * 注釈の反映先として選べるリポジトリ（`repos.list()` が唯一の一覧）。
   * 自由入力は受けない（存在しないパスへ誤って起票しないため）。
   */
  function targets() {
    const list = typeof opts.targets === 'function' ? opts.targets() : []
    if (!Array.isArray(list)) return []
    const out = []
    for (const r of list) {
      const abs = String(r?.path ?? '')
      const id = String(r?.id ?? '').trim()
      if (!abs || !id) continue
      out.push({ id, label: String(r.label ?? id), path: abs })
    }
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
   * 反映先パス → 登録済みリポジトリ（**最長一致**）。
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
   * レビューのタスク本文 `[review] label=… image=shots/x.png target=<path>` の対応を集め、
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
      rs = db.prepare("SELECT body FROM tasks WHERE body LIKE '%[review]%' OR body LIKE '%[akapen]%'").all()
    } catch {
      rs = []
    } finally {
      db.close()
    }
    for (const r of rs) {
      const ak = parseReviewLine(r.body)
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
   * 作業フィード（内蔵 reviewWatcher が書く 1 行ログ）。
   *
   * 旧来は外部 cron（`mobile-akapen-watch`）が Discord と `plugin-data/akapen/feed.jsonl` を
   * 書いていた。D7 でブリッジ内蔵の `reviewWatcher` に移し、`review/feed.jsonl` をここから読む。
   *
   * @param {number} [limit] 末尾から何行読むか（1..200）
   * @param {number} [since] この epoch ms より新しい行だけ返す（0 なら全部）
   * @returns {Array<{at: number, text: string}>} 古い順
   */
  function feed(limit = 20, since = 0) {
    const file = path.join(reviewRoot(), 'feed.jsonl')
    let raw = ''
    try {
      raw = readTailText(file, 128 * 1024)
    } catch {
      return [] // まだ 1 行も無いだけなので空でよい
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
   * レビューの完了報告の生データ（監視 cron `mobile-review-watch` が書く 1 行/タスク）。
   *
   * 1 会話だけを見る `chatReport` と、全会話を見る `chatReports` の共通読み取り。
   * ファイルが無い（＝宛先つきのタスクがまだ完了していない）のは正常なので空で返す。
   *
   * @returns {Array<{at: number, sessionId: string, taskId: string, label: string|null, text: string}>} 古い順
   */
  function readChatReportRows() {
    const file = path.join(reviewRoot(), 'chat-reports.jsonl')
    let raw = ''
    try {
      raw = readTailText(file, 256 * 1024)
    } catch {
      return []
    }
    const taskChats = readTaskChats()
    const out = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line)
        const at = Date.parse(String(j.at ?? ''))
        if (!Number.isFinite(at)) continue
        const taskId = String(j.task_id ?? '')
        let sessionId = String(j.session_id ?? '')
        if (!sessionId && taskId) {
          sessionId = taskChats[taskId] || sanitizeChatId(parseReviewLine(bodyOf(taskId)?.body)?.chat) || ''
        }
        if (!sessionId) continue
        // パイプライン統合レポート（`kind: 'pipeline'`）の追加フィールドは**透過的に**保持する。
        // 既存のレビュー 1 行レポート（at/session_id/task_id/label/text だけ）は今まで通り。
        out.push({
          at,
          sessionId,
          taskId,
          label: j.label ?? null,
          text: String(j.text ?? ''),
          kind: j.kind ? String(j.kind) : null,
          status: j.status ? String(j.status) : null,
          board: j.board ? String(j.board) : null,
          spec: j.spec ? String(j.spec) : null,
          repoPath: j.repo_path ? String(j.repo_path) : null,
          markdown: typeof j.markdown === 'string' ? j.markdown : '',
          followUpPrompt: typeof j.follow_up_prompt === 'string' ? j.follow_up_prompt : '',
          counts: j.counts && typeof j.counts === 'object' && !Array.isArray(j.counts) ? j.counts : null,
        })
      } catch {
        // 書きかけ・壊れた行は捨てる（補助情報）
      }
    }
    return out
  }

  /**
   * ある会話に流すレビューの完了報告（監視 cron `mobile-review-watch` が書く）。
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
    const limit = Math.min(Math.max(Number(opts.limit) || 3, 1), 50)
    const since = Number(opts.since) || 0
    const out = readChatReportRows()
      .filter((r) => r.sessionId === id)
      .filter((r) => !since || r.at > since)
      .map(({ sessionId: _sid, ...rest }) => rest)
    return out.slice(-limit)
  }

  /**
   * 全会話ぶんの完了報告（未読の点を出すため）。
   *
   * 下部ナビのチャットタブと「会話」一覧の行に点を出すには「どの会話に新着があるか」を
   * 1 回で知る必要がある。会話ごとに問い合わせると N 回になるので、絞らずに返して
   * 端末側で既読時刻（localStorage）と突き合わせる。
   *
   * @param {{limit?: number, since?: number}} [opts] 末尾何件（既定 200）・この epoch ms より新しい行だけ
   * @returns {Array<{at: number, sessionId: string, taskId: string, label: string|null, text: string}>} 古い順
   */
  function chatReports(opts = {}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 500)
    const since = Number(opts.since) || 0
    const out = readChatReportRows().filter((r) => !since || r.at > since)
    return out.slice(-limit)
  }

  /** library の画像を返す（allowlist 内のみ）。 */
  function libraryFile(rel) {
    if (!isSafeRel(rel)) return { ok: false, code: 'BAD_PATH' }
    const lower = String(rel).toLowerCase()
    if (!(lower.startsWith('library/') || lower.startsWith('shots/'))) {
      return { ok: false, code: 'OUTSIDE' }
    }
    if (!/\.(png|jpe?g|webp)$/.test(lower)) return { ok: false, code: 'BAD_EXT' }
    const abs = resolveInside(rel)
    if (!abs) return { ok: false, code: 'NOT_FOUND' }
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
      if (!m) return { ok: false, code: 'BAD_IMAGE' }
      buf = Buffer.from(m[2], 'base64')
      ext = m[1] === 'image/png' ? '.png' : '.jpg'
      if (buf.length > 12 * 1024 * 1024) return { ok: false, code: 'TOO_LARGE' }
    } else {
      const rel = String(payload?.path || '')
      if (!isSafeRel(rel)) return { ok: false, code: 'BAD_PATH' }
      if (!(rel.toLowerCase().startsWith('library/') || rel.toLowerCase().startsWith('shots/'))) {
        return { ok: false, code: 'OUTSIDE' }
      }
      const abs = resolveInside(rel)
      if (!abs) return { ok: false, code: 'NOT_FOUND' }
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
        targets: targets().map((x) => ({ id: x.id, label: x.label })),
      }
    }
    const target = picked.path
    // 起票した会話へ完了報告を返す宛先（レビュー chat-badge-01 q1=A の「紐づけ」）。
    // 注釈タスクは bridge が本文を組み立てるので、端末が渡さないと `chat=` が付かず
    // 完了が会話に戻らない（従来の宛先つきはレビューシート経由だけだった）。
    const chat = sanitizeChatId(payload?.chat)
    const body =
      `[review] label=${label} round=1 mode=annotation image=${relShot} target=${target}` + (chat ? ` chat=${chat}` : '')
    // assignee が無いと dispatcher が拾わない（実測: ready のまま止まる）
    const created = await runKanban(['create', title, '--body', body, '--assignee', 'mobile'])
    const m = /t_[0-9a-f]{8}/.exec(created.out || '')
    if (created.code !== 0 || !m) {
      return { ok: false, code: 'CREATE_FAILED', message: created.out.slice(0, 300) }
    }
    const taskId = m[0]
    if (chat) rememberTaskChat(taskId, chat)
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

  /**
   * タスクの宛先チャット（本文の `chat=` → `task-chats.json`）。
   * reviewWatcher が完了報告の宛先を決めるのに使う（SPEC §4.3）。
   */
  function chatFor(id) {
    const b = bodyOf(id)
    const fromBody = sanitizeChatId(parseReviewLine(b?.body)?.chat)
    if (fromBody) return fromBody
    return readTaskChats()[id] || null
  }

  return {
    board,
    workdir,
    dataRoot,
    reviewRoot,
    chatFor,
    list,
    sheetHtml,
    sheetData,
    answer,
    reopen,
    approve,
    sessionId,
    image,
    annotation,
    saveAnnotation,
    thumb,
    library,
    libraryFile,
    createFromImage,
    targets,
    feed,
    chatReport,
    chatReports,
  }
}
