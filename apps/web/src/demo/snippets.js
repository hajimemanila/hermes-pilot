/**
 * デモ用の定型スニペット（フィクスチャ）。UI 文言ではなくデータなので日本語を含む。
 *
 * 本物の `GET /api/snippets` と同じ形（`hot` の 6 件がチップ帯、`text` が tooltip）。
 * 本番ビルド（`npm run build`）には含まれない（`main.jsx` の DEMO 分岐で動的 import）。
 */
/**
 * デモ用の定型スニペット（本物の `GET /api/snippets` と同じ形）。
 *
 * `hot` の 6 件が入力欄上のチップ帯（`.chips-scroll`）に並び、`text` が tooltip になる。
 * 先頭 2 件は意思決定トリガー（`trigger: true`）でアクセント枠。
 */
export const DEMO_SNIPPETS = {
  en: [
    { id: 'quick-review', label: '📋 Quick Review', text: 'Write the open decisions into a Quick Review sheet and file a blocked [review] task.', hot: true, trigger: true },
    { id: 'annotate-shot', label: '📸 Annotate Shot', text: 'Deploy, take a 390x844 screenshot and file an annotation task so I can redline it.', hot: true, trigger: true },
    { id: 'approve', label: '⚡ Approve & Go', text: 'Approved with the recommended option. Proceed and run verification.', hot: true },
    { id: 'spec-kanban', label: '🚀 Spec → Kanban', text: 'Read the latest docs/SPEC-*.md, create the kanban batches and start from the first.', hot: true },
    { id: 'retry', label: '🔄 Alt Approach', text: 'Stop repeating the last steps and try a different approach to the root issue.', hot: true },
    { id: 'summary', label: '📝 Summary', text: 'Summarize the decisions, open items and next steps in concise bullets.', hot: true },
    { id: 'git-diff', label: 'git diff', text: 'Run git diff and summarize the key changes in 3 lines.', hot: false },
    { id: 'test', label: 'Run Verify', text: 'Run npm run verify and fix any failing tests.', hot: false },
  ],
  ja: [
    { id: 'quick-review', label: '📋 Quick Review起票', text: 'いま判断が必要な論点を設問シートにまとめ、カンバンに blocked で起票して回答を待って。', hot: true, trigger: true },
    { id: 'annotate-shot', label: '📸 スクショ注釈起票', text: '最新ビルドを反映して 390x844 の実機スクショを撮り、赤入れ用のタスクを起票して。', hot: true, trigger: true },
    { id: 'approve', label: '⚡ 推奨案で承認・続行', text: '推奨案で承認します。このまま実装を進めて検証まで実行して。', hot: true },
    { id: 'spec-kanban', label: '🚀 SPECから自走', text: '最新の docs/SPEC-*.md を読み、バッチ順にカンバン起票して自走を開始して。', hot: true },
    { id: 'retry', label: '🔄 別アプローチ', text: '同じ手順の繰り返しを止め、根本原因に対する別のアプローチでやり直して。', hot: true },
    { id: 'summary', label: '📝 要点まとめ', text: '決定事項・未解決の論点・次の一手を簡潔な箇条書きで整理して。', hot: true },
    { id: 'git-diff', label: 'git diff', text: 'git diff を実行し、主要な変更点を3行で要約して。', hot: false },
    { id: 'test', label: 'テスト・検証', text: 'npm run verify を実行し、失敗があれば修正して。', hot: false },
  ],
}
