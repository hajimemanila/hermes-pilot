/**
 * ストレージキーの共有契約（SPEC-COHERENCE §3.1 / D81）。
 *
 * `localStorage` のキーは複数ファイルから触ると綴り間違いに気づけない（実測: 9 種が 2〜3 ファイルに
 * 重複していた）。新しいキーは**必ずここで 1 回だけ定義**し、参照側は定数を使う。
 *
 * 既存の定数名（`lib/theme.js` の `THEME_KEY` など）は各モジュールから再エクスポートして
 * 後方互換を保つ。値を持つのはこのファイルだけ。
 */

/** `localStorage` のキー。 */
export const HM_STORAGE = Object.freeze({
  /** 直前に見ていたボードの slug。 */
  BOARD: 'hm.board',
  /** 現在開いている会話 ID。 */
  STORED_SID: 'hm.storedSid',
  /** 新規会話未送信中でも引き継ぐ、直前の会話 ID。 */
  LAST_STORED_SID: 'hm.lastStoredSid',
  /** 言語設定（`en` / `ja` / `auto`）。 */
  LANG: 'hm.lang',
  /** Vibe モード（`dopamine` / `serotonin`）。 */
  VIBE: 'hm.vibe',
  /** 効果音の ON/OFF。 */
  SOUND: 'hm.sound',
  /** テーマ（`dark` / `light` / `system`）。 */
  THEME: 'hm.theme',
  /** レビューを見た最終時刻（epoch ms）。 */
  REVIEW_SEEN_AT: 'hm.reviewSeenAt',
  /** 会話一覧の行の点の既読（会話ごとの JSON）。 */
  CHAT_REPORT_SEEN: 'hm.chatReportSeen',
  /** ナビの点の既読時刻（epoch ms）。 */
  CHAT_REPORT_SEEN_AT: 'hm.chatReportSeenAt',
  /** 返信新着の既読（会話 ID → `{ count, at }`）。 */
  SESSION_SEEN: 'hm.session.seen.v1',
  /** 選択中リポジトリ。 */
  REPO: 'hm.repo',
  /** 最近使ったリポジトリ（配列）。 */
  REPO_RECENT: 'hm.repoRecent',
  /** レビュー用に選んだリポジトリ。 */
  REVIEW_REPO: 'hm.reviewRepo',
  /** リポジトリ選択待ちの要求。 */
  PENDING_REPO: 'hm.pendingRepo',
  /** 振動（ハプティック）の ON/OFF。 */
  HAPTIC: 'hm.haptic',
  /** 直近の会話のプロファイル。 */
  STORED_PROFILE: 'hm.storedProfile',
  /** 既定プロファイルを切り替えた目印（一度きりの移行用）。 */
  DEFAULT_PROFILE: 'hm.defaultProfile',
  /** スニペット帯 3 箇所の表示状態。 */
  SNIPPET_BARS: 'hm.snippetBars.v1',
  /** Service Worker 更新後の再読み込みループ防止（`sessionStorage`）。 */
  SW_RELOAD: 'hm.swReload',
  /** メモ一覧の表示モード（`one` / `two` / `list`）。 */
  MEMOS_VIEW: 'hm.memosView',
  /** Coherence 提案バナーを閉じた記録（`{ signature, at }` の JSON）。 */
  COHERENCE_DISMISSED: 'hm.coherenceDismissed',
  /** リポジトリごとの退避済みソフトシグナル（`{ [repoKey]: { [signalKey]: { value, at } } }` の JSON）。 */
  COHERENCE_ACK: 'hm.coherenceAck',
})
