/**
 * Review シート / ビューの HTML 生成（CSP ヘッダ・埋め込みスクリプト込み）。`review.js` から分割。
 * 公開契約は `review.js` の再エクスポートで維持する。
 */
import { OPS_TEXT, REPLY_TEXT, REPLY_HEAD_RE, REPLY_MARK_SOURCE, opsText, replyTextOf } from './text.js'

export function escapeHtmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 生成 HTML の文言（`lang` ごと・キー集合は両言語で同一／SPEC-i18n-gen §3.2）。
 *
 * シート・単体タブのラッパー・アプリ内ブリッジが**人が読む**文だけをここに集める。
 * 設問・選択肢・`topic`・`title` はデータそのままで訳さない。機械トークン
 * （`sheet.json` / `/api/review/…` / `[Review Answer]`）は ASCII のまま動かさない。
 */
export const HTML_TEXT = {
  en: {
    recBadge: 'Recommended',
    note: 'This sheet was generated from <code>sheet.json</code>. Send your answers from the Review tab in the app (quick answer form).',
    empty: 'No questions.',
    viewTitle: 'Review sheet',
    iframeTitle: 'Review sheet',
    sending: 'Sending…',
    sent: 'Answer sent (task is now {moved}).',
    sendFailed: 'Could not send: {detail}',
    sendError: 'Send error: {detail}',
    sheetLoadFailed: 'Could not load the sheet: {src}',
    bridgeSent: 'Sent the answer to the app (you can close this screen).',
    bridgeManual: "This screen cannot send directly. Open it from the app's Review tab, or from {view}.",
    bridgeButton: 'Send answer',
    bridgeNote:
      'Pick your options and press [Send answer] and it goes straight to the app (unselected items settle on the recommended option).',
  },
  ja: {
    recBadge: '推奨',
    note: 'このシートは <code>sheet.json</code> から自動生成した閲覧ビューです。回答はアプリのレビュータブ（簡易回答フォーム）から送ってください。',
    empty: '設問がありません。',
    viewTitle: 'レビューシート',
    iframeTitle: 'レビューシート',
    sending: '送信中…',
    sent: '回答を送信しました（タスクは {moved}）',
    sendFailed: '送信できませんでした: {detail}',
    sendError: '送信エラー: {detail}',
    sheetLoadFailed: 'シートを読み込めません: {src}',
    bridgeSent: 'アプリに回答を送りました（この画面は閉じてOK）',
    bridgeManual: 'この画面からは直接送信できません。アプリのレビュータブ、または {view} から開いてください',
    bridgeButton: '回答を送信',
    bridgeNote: '選んで［回答を送信］を押すと、そのままアプリに送られます（未選択は推奨案で確定）。',
  },
}

/**
 * `lang` に対応する生成 HTML の文言表（未知の言語は `en`）。
 * @param {string} [lang] 言語
 * @returns {(typeof HTML_TEXT)['en']} 文言表
 */
export function htmlText(lang) {
  return lang === 'ja' ? HTML_TEXT.ja : HTML_TEXT.en
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
 * @param {'en'|'ja'} [lang] 文言の言語（既定 `en`・SPEC-i18n-gen §3.1）
 * @returns {string} `<!DOCTYPE html>` で始まる完全な HTML
 */
export function renderSheetHtmlFromData(data, ak = {}, lang = 'en') {
  const L = lang === 'ja' ? 'ja' : 'en'
  const T = htmlText(L)
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
        `          <span class="olabel">${esc(o?.label ?? '')}${rec ? `<span class="rec-badge">${T.recBadge}</span>` : ''}</span>`,
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
<html lang="${L}">
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
  <p class="note">${T.note}</p>
${topic ? `  <div class="topic">${topic}</div>` : ''}
${sections.length ? sections.join('\n') : `  <p class="empty">${T.empty}</p>`}
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
 * JS の文字列リテラルを作る（非 ASCII は `\uXXXX` へ）。
 *
 * 生成するスクリプトを **ASCII だけ**に保つため（`?lang=en` の出力に CJK を残さない・
 * SPEC-i18n-gen §3.2）。`【レビュー回答】` のような受理マーカーもこれで埋める。
 *
 * @param {string} value 値
 * @returns {string} `"..."` 形式のリテラル
 */
function asciiScriptString(value) {
  return JSON.stringify(String(value)).replace(
    /[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/**
 * 単体タブ用のラッパー HTML（D57）。
 *
 * `/api/review/:id/sheet` は常に sandbox なので、シート単体では回答を POST できない。
 * このラッパーが same-origin の親として sandbox `<iframe>` を抱え、
 * シートからの `postMessage` を `POST /api/review/:id/answer` へ中継する。
 *
 * @param {string} taskId タスク id
 * @param {'en'|'ja'} [lang] 文言の言語（既定 `en`・SPEC-i18n-gen §3.1）
 * @returns {string} HTML
 */
export function reviewViewHtml(taskId, lang = 'en') {
  const L = lang === 'ja' ? 'ja' : 'en'
  const T = htmlText(L)
  const id = String(taskId)
  const jsTask = scriptJson(id)
  // iframe はブラウザが直接 GET するので、言語はクエリで渡す（親のヘッダは付かない）。
  const sheetHref = `/api/review/${encodeURIComponent(id)}/sheet?lang=${L}`
  const jsSrc = scriptJson(sheetHref)
  const jsText = {
    sending: scriptJson(T.sending),
    sent: scriptJson(T.sent),
    sendFailed: scriptJson(T.sendFailed),
    sendError: scriptJson(T.sendError),
    sheetLoadFailed: scriptJson(T.sheetLoadFailed),
  }
  return `<!doctype html>
<html lang="${L}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtmlText(T.viewTitle)} ${escapeHtmlText(id)}</title>
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
<iframe id="akViewSheet" src="${escapeHtmlText(sheetHref)}" sandbox="allow-scripts allow-forms" title="${escapeHtmlText(T.iframeTitle)}"></iframe>
<div id="akViewStatus" role="status" aria-live="polite"></div>
<script>
(function () {
  var TASK = ${jsTask};
  var SHEET = ${jsSrc};
  var TXT = {
    sending: ${jsText.sending},
    sent: ${jsText.sent},
    sendFailed: ${jsText.sendFailed},
    sendError: ${jsText.sendError},
    sheetLoadFailed: ${jsText.sheetLoadFailed}
  };
  // Fills one placeholder without a regex (keeps the generated script small)
  function fill(s, k, v) { return String(s).split('{' + k + '}').join(v == null ? '' : String(v)); }
  var box = document.getElementById('akViewStatus');
  var timer = 0;
  function note(ok, msg) {
    box.textContent = msg;
    box.className = 'show ' + (ok ? 'ok' : 'ng');
    clearTimeout(timer);
    // Hide a success notice quickly; keep failures on screen so they can be read.
    if (ok) timer = setTimeout(function () { box.className = ''; }, 4000);
  }
  function title(el) {
    return (el && ((el.error && el.error.message) || el.message)) || 'unknown';
  }
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d) return;
    // Accept the legacy sheet message (akapen:reply) as well; new sheets send review:reply.
    if (d.type !== 'review:reply' && d.type !== 'akapen:reply') return;
    if (String(d.taskId) !== TASK) return;
    var text = String(d.text || '');
    if (!text) return;
    note(true, TXT.sending);
    fetch('/api/review/' + encodeURIComponent(TASK) + '/answer', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-client': 'mobile' },
      body: JSON.stringify({ text: text, by: 'web' })
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: r.ok, j: null }; });
    }).then(function (res) {
      var ok = Boolean(res.ok && res.j && res.j.ok);
      note(ok, ok ? fill(TXT.sent, 'moved', res.j.moved || '—') : fill(TXT.sendFailed, 'detail', title(res.j)));
    }).catch(function (e) {
      note(false, fill(TXT.sendError, 'detail', e && e.message ? e.message : e));
    });
  });
  // Do not show a blank white screen when the sheet cannot be loaded (404 and so on)
  var frame = document.getElementById('akViewSheet');
  if (frame) frame.addEventListener('error', function () { note(false, fill(TXT.sheetLoadFailed, 'src', SHEET)); });
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
 *
 * @param {string} html シート HTML
 * @param {string} taskId タスク id
 * @param {'en'|'ja'} [lang] 文言の言語（既定 `en`・SPEC-i18n-gen §3.1）
 * @returns {string} 注入後の HTML
 */
export function injectReviewBridge(html, taskId, lang = 'en') {
  const L = lang === 'ja' ? 'ja' : 'en'
  const T = htmlText(L)
  // 受理マーカーは CJK を含むので ASCII エスケープで埋める（`?lang=en` の出力に CJK を残さない）。
  const jsMark = asciiScriptString(REPLY_MARK_SOURCE)
  const jsText = {
    sent: scriptJson(T.bridgeSent),
    manual: scriptJson(T.bridgeManual),
    button: scriptJson(T.bridgeButton),
    note: scriptJson(T.bridgeNote),
  }
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
  var MARK = new RegExp(${jsMark});
  var TXT = { sent: ${jsText.sent}, manual: ${jsText.manual}, button: ${jsText.button}, note: ${jsText.note} };
  // Fills one placeholder
  function fill(s, k, v) { return String(s).split('{' + k + '}').join(v == null ? '' : String(v)); }
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
    // Legacy sheets emit the old Japanese header; current ones emit "[Review Answer]" (MARK accepts both).
    if (!text || !MARK.test(text)) return;
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'review:reply', taskId: TASK, text: text }, '*');
      report(true, TXT.sent);
      return;
    }
    // The sheet is always served as sandbox (opaque origin), so it cannot call the API itself.
    // Answers always go to the parent (the PWA iframe or the /api/review/:id/view wrapper) via postMessage.
    report(false, fill(TXT.manual, 'view', '/api/review/' + TASK + '/view'));
  }
  // Inside the app, show this as "send" rather than "paste"
  function relabel() {
    var b = document.getElementById('genBtn');
    if (b) b.textContent = TXT.button;
    var note = document.querySelector('#akForm p.m');
    if (note) note.textContent = TXT.note;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', relabel);
  else relabel();

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t && (t.id === 'genBtn' || (t.closest && t.closest('#genBtn')))) setTimeout(submit, 80);
  }, true);
  window.__reviewSubmit = submit;
  // Compatibility alias: pre-migration sheet assets call this directly (SPEC §4.1)
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
