/**
 * Autopilot モード専用の Architect / Quick Review 契約ヘルパ。
 *
 * 従来の Cockpit 契約（`zero-stop` の JSON ファースト高速ルール）には一切触れず、
 * `autopilot: true` で起票されたときだけ「選択肢ごとにビジュアルモック付き 1 カード」と
 * 「完走時の Preview URL / Launch コマンド明記」をプロンプトへ注入する。
 *
 * 汎用スキル境界（`skillsGeneric.test.js` / `findHardcodedVerification`）を守るため、
 * 特定リポジトリ固有のコマンド名や画面サイズ直書きは含めない。
 */

/**
 * Autopilot モードの Round 1 プロンプト指示（ASCII 英語）。
 * @param {{slug: string}} input
 * @returns {string[]}
 */
export function buildAutopilotRound1Lines({ slug }) {
  const s = String(slug || 'spec').trim() || 'spec'
  return [
    `Autopilot Visual-First Round 1 — write \`review/sheets/spec-${s}-1.json\` with \`"mode": "standard"\`, \`"deck": true\`, and 2-3 visual design decisions.`,
    'For EACH option (A, B, C) of every question, attach a distinct `visualMock` (`shot` under `shots/` or `thumbs/`, optional lightweight static `html` under `sheets/`, plus `layoutVariant`, `theme`, `tagline`) so the phone shows Option A as card 1 and flips to Option B / C on left-swipe.',
    'Generate lightweight static HTML mockups or thumbnails sized to the target repository’s declared mobile viewport (locate only the relevant entry files first; skip running full test or build suites in Round 1), then file the blocked `[review]` task whose machine line reads:',
    `\`[review] label=spec-${s} round=1 mode=standard sheet=sheets/spec-${s}-1.json target=<repo>\` and wait.`,
  ]
}

/**
 * 成果物チェック用の完走サマリ契約（サイト URL・アプリ起動方法の明記）。
 * @returns {string[]}
 */
export function buildAutopilotDeliverableLines() {
  return [
    'Final Deliverable Handoff — build a static web bundle when building a web UI (e.g. `dist/index.html` or `index.html`) so Hermes Pilot serves it automatically on the same authenticated origin (`/api/boards/<board>/preview-files/`).',
    'NEVER output loopback (`127.0.0.1`, `localhost`) or ephemeral LAN IP (`192.168.x.x`) preview URLs in user-facing summaries.',
    'In the final batch completion summary and report text, include machine-readable handoff details:',
    '  - `Preview: dist/index.html` (or an explicit public `https://...` URL if deployed externally)',
    '  - `Launch: <one-line command to start or open the app>` (whenever a local CLI or app launch applies)',
  ]
}
