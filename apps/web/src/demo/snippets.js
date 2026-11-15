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
