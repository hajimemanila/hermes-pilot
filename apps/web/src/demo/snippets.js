/**
 * デモ用の定型スニペット（フィクスチャ）。UI 文言ではなくデータなので日本語を含む。
 *
 * **本番（`apps/bridge/src/snippets.js` の `BUILTIN`）と完全同期**する。id・順序・
 * `hot`/`trigger`/`action`・en/ja の label と text は 1 文字も変えない
 * （`apps/web/test/demoMode.test.js` の同期テストが本物の `SNIPPETS` と突き合わせる）。
 *
 * 本番と同じ形（`hot` の 7 件がチップ帯、`text` が tooltip、`action: 'seed'` は
 * 入力欄ではなく仕様策定シートを開く）。本番ビルド（`npm run build`）には含まれない
 * （`main.jsx` の DEMO 分岐で動的 import）。
 */

/**
 * デモの組み込みスニペット（本番 `BUILTIN` の写し）。
 * @type {Array<{id: string, hot?: boolean, trigger?: boolean, action?: string, en: {label: string, text: string, placeholder?: string}, ja: {label: string, text: string, placeholder?: string}}>}
 */
export const DEMO_BUILTIN = [
  // --- Hot（バーに出す 7 件）------------------------------------------------
  {
    id: 'spec-seed',
    hot: true,
    trigger: true,
    action: 'seed',
    en: {
      label: '📝 Spec Seed',
      text:
        'Start a spec interview from this one-line note: put the 2-3 open design decisions on a Quick Review sheet (each with recommended: true), wait for my 1-tap answer, then write docs/SPEC-<SLUG>.md with Execution Mode, 目的, 変更ファイル and 受入条件 per batch.',
    },
    ja: {
      label: '📝 仕様策定',
      text:
        'この一行メモから仕様策定インタビューを始めて。設計論点を2〜3問の Quick Review シート（各問 recommended: true）にして1タップ回答を待ち、回答後に docs/SPEC-<SLUG>.md をバッチごとの Execution Mode・目的・変更ファイル・受入条件つきで書いて。',
    },
  },
  {
    id: 'quick-review',
    hot: true,
    trigger: true,
    en: {
      label: '📋 Quick Review',
      text:
        'Summarize the open design decisions into a Quick Review sheet (HTML + JSON under review/sheets/) using the quick-review skill, file a blocked [review] task on kanban, and wait for my 1-tap answer.',
    },
    ja: {
      label: '📋 Quick Review起票',
      text:
        'いま判断が必要な論点を quick-review スキルで設問シート（review/sheets/ の HTML + JSON）にまとめ、カンバンに blocked の [review] タスクとして起票して回答を待って。',
    },
  },
  {
    id: 'annotate-shot',
    hot: true,
    trigger: true,
    en: {
      label: '📸 Annotate Shot',
      text:
        'Deploy the latest build, take a 390x844 screenshot into review/shots/, and file a blocked [review] mode=annotation task using the annotation skill so I can redline it.',
    },
    ja: {
      label: '📸 スクショ注釈起票',
      text:
        '最新ビルドを反映して 390x844 の実機スクショを review/shots/ に撮り、annotation スキルで赤入れ用の blocked [review] タスクを起票して。',
    },
  },
  {
    id: 'approve',
    hot: true,
    en: {
      label: '⚡ Approve & Go',
      text: 'Approved with the recommended option. Proceed with implementation and run verification.',
    },
    ja: {
      label: '⚡ 推奨案で承認・続行',
      text: '推奨案で承認します。このまま実装を進めて検証（verify）まで実行して。',
    },
  },
  {
    id: 'spec-kanban',
    hot: true,
    en: {
      label: '🚀 Spec → Kanban',
      text:
        'Read the latest docs/SPEC-*.md in this repo, create the kanban batch tasks in order, and start autonomous execution from the first batch.',
    },
    ja: {
      label: '🚀 SPECから自走',
      text: 'このリポジトリの最新の docs/SPEC-*.md を読み、バッチ順にカンバンタスクを起票して最初のバッチから自走を開始して。',
    },
  },
  {
    id: 'retry',
    hot: true,
    en: {
      label: '🔄 Alt Approach',
      text: 'Stop repeating the last steps. Propose and execute a different approach to solve the root issue.',
    },
    ja: {
      label: '🔄 別アプローチ',
      text: '同じ手順の繰り返しを止め、根本原因に対する別のアプローチでやり直して。',
    },
  },
  {
    id: 'summary',
    hot: true,
    en: {
      label: '📝 Summary',
      text: 'Summarize the decisions made, remaining open items, and next steps from this conversation in concise bullets.',
    },
    ja: {
      label: '📝 要点まとめ',
      text: 'ここまでの決定事項・未解決の論点・次の一手を簡潔な箇条書きで整理して。',
    },
  },

  // --- シート（8 件）--------------------------------------------------------
  {
    id: 'git-diff',
    en: {
      label: 'git diff',
      text: 'Run git diff in the working repo and summarize the key changes in 3 lines.',
    },
    ja: { label: 'git diff', text: '作業中のリポジトリで git diff を実行し、主要な変更点を3行で要約して。' },
  },
  {
    id: 'git-status',
    en: { label: 'git status', text: 'Run git status --short and list any uncommitted or untracked files.' },
    ja: { label: 'git status', text: 'git status --short を実行して、未コミット・未追跡ファイルを一覧にして。' },
  },
  {
    id: 'test',
    en: { label: 'Run Verify', text: 'Run npm run verify (or the project test suite) and fix any failing tests.' },
    ja: { label: 'テスト・検証', text: 'npm run verify（または関連テスト）を実行し、失敗があれば修正して。' },
  },
  {
    id: 'review',
    en: {
      label: 'Bug Review',
      text: 'Review the latest diff focusing on bugs and regressions. List by severity with file:line (do not edit yet).',
    },
    ja: {
      label: 'バグ監査',
      text: '直前の差分をバグ・デグレ優先で監査して。重大度順・file:line 付きで列挙し、まだコードは変えないで。',
    },
  },
  {
    id: 'explain',
    en: {
      label: 'Explain 3L',
      text: 'Explain the code or behavior we just touched in 3 lines for someone seeing it for the first time.',
    },
    ja: { label: '3行で説明', text: '直前に触ったコードや挙動を、初見の人向けに3行で説明して。' },
  },
  {
    id: 'cause',
    en: {
      label: 'Diagnose',
      text: 'Identify the root cause of this error and propose the single safest fix.\nError: {{paste here}}',
      placeholder: '{{paste here}}',
    },
    ja: {
      label: '原因特定',
      text: '次のエラーの根本原因を特定し、最も安全な修正案を1つ提案して。\nエラー: {{ここに貼り付け}}',
      placeholder: '{{ここに貼り付け}}',
    },
  },
  {
    id: 'handoff',
    en: {
      label: 'Handoff',
      text: 'Write a compact handoff note (current state / decisions / next action) so a background worker can continue.',
    },
    ja: {
      label: '引き継ぎメモ',
      text: '自律ワーカーがそのまま引き継げるよう、現状・決定事項・次の一手をコンパクトにまとめて。',
    },
  },
  {
    id: 'kanban',
    en: {
      label: 'Kanban Next',
      text: 'Check the running and blocked kanban tasks and tell me the single highest-priority item.',
    },
    ja: { label: 'カンバン確認', text: 'カンバンの実行中・ブロック中タスクを確認し、最優先で片付けるべき1件を教えて。' },
  },
]

/**
 * 組み込み 1 件を UI 用の形にする（本番 `snippets.js` の `toUi` と同じ形）。
 * @param {object} s 組み込み
 * @param {'en'|'ja'} lang 言語
 * @returns {object} UI 用（`hidden`/`custom`/`hasPlaceholder` まで揃える）
 */
function toUi(s, lang) {
  const src = s[lang] ?? s.en
  return {
    id: s.id,
    label: src.label,
    hot: Boolean(s.hot),
    trigger: Boolean(s.trigger),
    ...(s.action ? { action: String(s.action) } : {}),
    hidden: false,
    custom: false,
    hasPlaceholder: Boolean(src.placeholder),
    text: src.text,
  }
}

/**
 * デモの `GET /api/snippets` が返す一覧（本番の `listSnippets([], lang)` と同じ形）。
 * `hot` の 7 件が入力欄上のチップ帯（`.chips-scroll`）に並び、`text` が tooltip になる。
 */
export const DEMO_SNIPPETS = {
  en: DEMO_BUILTIN.map((s) => toUi(s, 'en')),
  ja: DEMO_BUILTIN.map((s) => toUi(s, 'ja')),
}

/**
 * デモの端末タブ用スニペット（本番 `apps/bridge/src/term-snippets.js` の `TABLE` の写し）。
 *
 * V10 §3.3 / D47: 本番の `GET /api/snippets/term` と同じ `{id, label, text, hot, run, note}` を
 * 同じ順で返す（デモでもチップ帯・長押し実行・ツールチップが本番と同じ見た目になる）。
 * `text` は macOS（launchd・`ai.hermes.pilot`）の既定と同じ綴りに固定してある
 * （デモは 1 つの環境しか持たないので Capability 分岐を持たない）。
 *
 * @type {{id: string, hot?: boolean, run?: boolean, en: [string, string], ja: [string, string], text: string}[]}
 */
export const DEMO_TERM_BUILTIN = [
  // --- Hot 6（バーに出す）----------------------------------------------------
  {
    id: 't-pilot-restart',
    hot: true,
    run: true,
    en: ['Restart Pilot', 'Restart Hermes Pilot bridge (4097)'],
    ja: ['Pilot再起動', 'Hermes Pilot ブリッジ(4097)を再起動'],
    text: 'launchctl kickstart -k gui/$(id -u)/ai.hermes.pilot',
  },
  {
    id: 't-gw-status',
    hot: true,
    run: true,
    en: ['GW Status', 'Hermes gateway status & PID'],
    ja: ['GW状態', 'gateway の稼働状況・PID'],
    text: 'hermes gateway status',
  },
  {
    id: 't-gw-restart',
    hot: true,
    run: true,
    en: ['Restart GW', 'Restart Hermes gateway'],
    ja: ['GW再起動', 'gateway を再起動'],
    text: 'hermes gateway restart',
  },
  {
    id: 't-drain-restart',
    hot: true,
    run: true,
    en: ['Clear Drain + GW', 'Remove drain marker & restart GW'],
    ja: ['解除+GW再起動', 'ドレイン解除＋gateway再起動'],
    text: 'rm -f ~/.hermes/.drain_request.json && hermes gateway restart',
  },
  {
    id: 't-kanban',
    hot: true,
    run: true,
    en: ['Kanban Active', 'List kanban tasks'],
    ja: ['カンバン一覧', 'カンバンのタスク一覧'],
    text: 'hermes kanban list',
  },
  {
    id: 't-gw-log',
    hot: true,
    run: true,
    en: ['GW Log', 'Last 80 lines of gateway.log'],
    ja: ['GWログ', 'gateway.log の末尾80行'],
    text: 'tail -n 80 ~/.hermes/logs/gateway.log',
  },
  // --- シート（10個）----------------------------------------------------------
  {
    id: 't-pilot-status',
    run: true,
    en: ['Pilot Status', 'Service status of Hermes Pilot'],
    ja: ['Pilot状態', 'Hermes Pilot のサービス状態'],
    text: 'launchctl print gui/$(id -u)/ai.hermes.pilot | head -20',
  },
  {
    id: 't-pair-qr',
    run: true,
    en: ['Pairing QR', 'Show pairing URL & QR in terminal'],
    ja: ['ペアリングQR', 'ペアリングURLとQRを表示'],
    text: 'npx hermes-pilot qr',
  },
  {
    id: 't-verify',
    run: true,
    en: ['Run Verify', 'Run tests, PWA check, and build'],
    ja: ['Verify実行', 'テスト・PWA検査・ビルドを一括実行'],
    text: 'npm run verify',
  },
  {
    id: 't-deploy',
    run: true,
    en: ['Deploy Web', 'Zero-downtime build & swap dist'],
    ja: ['Webデプロイ', '無停止ビルド＆dist入れ替え'],
    text: 'npm run deploy',
  },
  {
    id: 't-drain-clear',
    run: true,
    en: ['Clear Drain', 'Remove drain marker only'],
    ja: ['ドレイン解除', 'ドレインマーカーのみ削除'],
    text: 'rm -f ~/.hermes/.drain_request.json && echo "drain marker removed"',
  },
  {
    id: 't-list',
    run: true,
    en: ['Services', 'List Hermes background services'],
    ja: ['サービス一覧', 'hermes 系サービス一覧'],
    text: 'launchctl list | grep -i hermes',
  },
  {
    id: 't-errors',
    run: true,
    en: ['Error Log', 'Last 80 lines of errors.log'],
    ja: ['エラーログ', 'errors.log の末尾80行'],
    text: 'tail -n 80 ~/.hermes/logs/errors.log',
  },
  {
    id: 't-health',
    run: true,
    en: ['Reachability', 'Check HTTP 200 on 9119 & 4097'],
    ja: ['疎通確認', '9119 と 4097 の HTTP 応答確認'],
    text:
      'curl -s -o /dev/null -w "dashboard %{http_code}\\n" http://127.0.0.1:9119/; ' +
      'curl -s -o /dev/null -w "pilot %{http_code}\\n" http://127.0.0.1:4097/healthz',
  },
  {
    id: 't-port',
    run: true,
    en: ['Ports', 'Check listening processes on 9119 & 4097'],
    ja: ['ポート確認', '9119 と 4097 の LISTEN 確認'],
    text: 'lsof -nP -iTCP:9119 -sTCP:LISTEN; lsof -nP -iTCP:4097 -sTCP:LISTEN',
  },
  {
    id: 't-git',
    run: true,
    en: ['Git State', 'Short status & last 3 commits'],
    ja: ['git状態', '差分と直近3コミット'],
    text: 'git status --short && git log --oneline -3',
  },
]

/**
 * 端末スニペットを UI 用の形にする（本番 `allTermSnippets` と同じフィールド）。
 * @param {object} s 組み込み
 * @param {'en'|'ja'} lang 言語
 * @returns {object} `{id, label, text, hot, run, note, hidden, custom}`
 */
function termToUi(s, lang) {
  const [label, note] = lang === 'ja' ? s.ja : s.en
  return {
    id: s.id,
    label,
    text: s.text,
    hot: Boolean(s.hot),
    run: s.run !== false,
    note,
    hidden: false,
    custom: false,
  }
}

/**
 * デモの `GET /api/snippets/term` が返す一覧（本番 `listTermSnippets(caps, lang)` と同じ形）。
 */
export const DEMO_TERM_SNIPPETS = {
  en: DEMO_TERM_BUILTIN.map((s) => termToUi(s, 'en')),
  ja: DEMO_TERM_BUILTIN.map((s) => termToUi(s, 'ja')),
}
