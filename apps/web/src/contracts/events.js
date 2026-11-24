/**
 * Frontend のイベント契約（SPEC-COHERENCE §3 / D81）。
 *
 * 画面をまたぐ通知は `window` の `CustomEvent` で飛ばしている。名前を各ファイルに
 * 生文字列で書くと、綴り間違いが「購読されないだけ」で静かに壊れる（実測: 25 種が
 * 21 ファイルに散在し、同じ名前を 13 箇所で書き写していた）。
 *
 * ルール:
 *  - 新しいイベントは**必ずここで 1 回だけ**定義し、`HM_EVENT_META` に payload を書く
 *  - 送信は `emitHmEvent(HM_EVENTS.X, detail)`、購読は `window.addEventListener(HM_EVENTS.X, fn)`
 *  - `contracts/` の外に `'hm:*'` の生文字列を書かない（`contracts.test.js` が機械検証する）
 *
 * このモジュールは Node のテストからそのまま import できる（DOM 参照は `emitHmEvent` の内側だけ）。
 */

/** 画面横断イベントの正本（25 種）。値は DOM イベント名そのもの。 */
export const HM_EVENTS = Object.freeze({
  /** レビュータスクを開く。 */
  OPEN_REVIEW: 'hm:open-review',
  /** カンバンのタスク詳細を開く。 */
  OPEN_TASK: 'hm:open-task',
  /** チャットの会話を開く（検索・レビュー・メモから）。 */
  OPEN_SESSION: 'hm:open-session',
  /** ライブ（実行中ターン）シートを開く。 */
  OPEN_LIVE: 'hm:open-live',
  /** 指定ボードをタスクタブで開く。 */
  OPEN_BOARD: 'hm:open-board',
  /**
   * タスクタブのインボックスを開く。
   *
   * 送信は App → TasksPane の prop（`pendingInboxOpen`）へ移行済みで、リポジトリ内に
   * 送信側が無い。後方互換のため定数と `TasksPane` の生 `addEventListener` だけ残す
   * （`HM_EVENT_META` には載せない＝`emitHmEvent` / `onHmEvent` の対象外）。
   */
  OPEN_INBOX: 'hm:open-inbox',
  /** メモの種から新しい会話を作る。 */
  OPEN_SEED: 'hm:open-seed',
  /** メモの種からブレインストームを始める。 */
  OPEN_BRAINSTORM: 'hm:open-brainstorm',
  /** 完走レポートから相談文をチャットへ置く。 */
  DISCUSS_PIPELINE: 'hm:discuss-pipeline',
  /** 復帰・可視化のタイミングで各画面が取り直す。 */
  WAKE_SYNC: 'hm:wake-sync',
  /** 完了報告だけを取り直す。 */
  REFRESH_REPORTS: 'hm:refresh-reports',
  /** レビュー待ち一覧の共有（ReviewPane → App）。 */
  REVIEW_ITEMS: 'hm:review-items',
  /** レビューを見た時刻の共有（ReviewPane → App）。 */
  REVIEW_SEEN: 'hm:review-seen',
  /** 承認待ち件数の共有（TasksPane → App）。 */
  INBOX_ITEMS: 'hm:inbox-items',
  /** 実行中ターン数と内訳（turns / items / architect）の共有（TasksPane → App）。 */
  LIVE_TURNS: 'hm:live-turns',
  /** 他タブの未読会話数（ChatPane → App）。 */
  CHAT_UNREAD: 'hm:chat-unread',
  /** チャットが応答中かどうか（ChatPane → App）。 */
  CHAT_STREAMING: 'hm:chat-streaming',
  /** メモの追加・更新・削除。 */
  MEMOS_CHANGED: 'hm:memos-changed',
  /** 定型文（チャット）の取り直し要求。 */
  SNIPPETS: 'hm:snippets',
  /** 定型コマンド（端末）の取り直し要求。 */
  TERM_SNIPPETS: 'hm:term-snippets',
  /** 言語の切り替え（辞書を引き直す）。 */
  LANG: 'hm:lang',
  /** Vibe モード（dopamine / serotonin）の切り替え。 */
  VIBE: 'hm:vibe',
  /** 効果音の ON/OFF 切り替え。 */
  SOUND: 'hm:sound',
  /** Dopamine のパーティクル発火。 */
  FX_BURST: 'hm:fx-burst',
  /** スニペット帯の表示切り替え。 */
  SNIPPET_BARS: 'hm:snippet-bars',
  /** Pilot 専用プロファイル（既定プロファイル）の切り替え。 */
  PILOT_PROFILE: 'hm:pilot-profile',
})

/**
 * イベントごとの契約（payload と向き）。
 *
 * - `detail`: `CustomEvent.detail` の形。`null` は detail を運ばない（`new Event` 相当）
 * - `from`: 送信側の代表ファイル、`to`: 購読側の代表ファイル（把握できている範囲）
 * - `required`: `detail` のうち**購読側が必須で読むキー**。`detail` がオブジェクトの
 *   イベントは必ず宣言する（SPEC D108）。送信側の実リテラルと突き合わせるのは
 *   `contracts.test.js`（SPEC D98）。
 *
 * `HM_EVENTS.OPEN_INBOX` だけはメタを持たない（送信側が prop 経路へ移行済み・
 * 後方互換の生 dispatch だけ受ける）。契約テストがその 1 件を名指しで固定する。
 */
export const HM_EVENT_META = Object.freeze({
  [HM_EVENTS.OPEN_REVIEW]: {
    detail: '{ taskId, board?, label?, jobId? }',
    from: 'LiveSheet / ChatPane / ArchitectJobBar',
    to: 'App',
    required: ['taskId'],
  },
  [HM_EVENTS.OPEN_TASK]: {
    detail: '{ board, taskId, jobId? }',
    from: 'LiveSheet / ChatPane / ArchitectJobBar',
    to: 'App',
    required: ['board', 'taskId'],
  },
  [HM_EVENTS.OPEN_SESSION]: {
    detail: '{ id, messageId?, profile? }',
    from: 'App (search) / ReviewPane',
    to: 'ChatPane / App',
    required: ['id'],
  },
  [HM_EVENTS.OPEN_LIVE]: {
    detail: '{ jobId }',
    from: 'ChatPane / ArchitectJobBar',
    to: 'App',
    required: ['jobId'],
  },
  [HM_EVENTS.OPEN_BOARD]: {
    detail: '{ board }',
    from: 'ChatPane / DemoBanner',
    to: 'App',
    required: ['board'],
  },
  [HM_EVENTS.OPEN_SEED]: {
    detail: '{ seed, repo?, board? }',
    from: 'MemosPane / ChatPane',
    to: 'App',
    required: ['seed'],
  },
  [HM_EVENTS.OPEN_BRAINSTORM]: {
    detail: '{ seed, memoId? }',
    from: 'MemosPane',
    to: 'App',
    required: ['seed'],
  },
  [HM_EVENTS.DISCUSS_PIPELINE]: {
    detail: '{ prompt, sessionId?, repoPath?, board?, title? }',
    from: 'ChatPane / TasksPane / TaskToolSheets',
    to: 'App',
    required: ['prompt'],
  },
  [HM_EVENTS.WAKE_SYNC]: { detail: null, from: 'App / ReviewPane / TasksPane / ChatPane / LiveSheet', to: 'TasksPane / ReviewPane / MemosPane / ChatPane / TermPane / SettingsPane / PipelinePanel' },
  [HM_EVENTS.REFRESH_REPORTS]: { detail: null, from: 'ChatPane / TasksPane / ReviewPane', to: 'App' },
  [HM_EVENTS.REVIEW_ITEMS]: { detail: '{ items }', from: 'ReviewPane', to: 'App', required: ['items'] },
  [HM_EVENTS.REVIEW_SEEN]: { detail: '{ at }', from: 'ReviewPane', to: 'App', required: ['at'] },
  [HM_EVENTS.INBOX_ITEMS]: { detail: '{ items }', from: 'TasksPane', to: 'App', required: ['items'] },
  [HM_EVENTS.LIVE_TURNS]: {
    detail: '{ turns, items, architect }',
    from: 'TasksPane',
    to: 'App',
    required: ['turns', 'items', 'architect'],
  },
  [HM_EVENTS.CHAT_UNREAD]: { detail: '{ count }', from: 'ChatPane', to: 'App', required: ['count'] },
  [HM_EVENTS.CHAT_STREAMING]: { detail: '{ streaming }', from: 'ChatPane', to: 'App', required: ['streaming'] },
  [HM_EVENTS.MEMOS_CHANGED]: { detail: null, from: 'ChatPane / TaskToolSheets', to: 'MemosPane' },
  [HM_EVENTS.SNIPPETS]: { detail: null, from: 'SettingsPane / i18n', to: 'ChatPane' },
  [HM_EVENTS.TERM_SNIPPETS]: { detail: null, from: 'SettingsPane / i18n', to: 'TermPane' },
  [HM_EVENTS.LANG]: { detail: '{ lang }', from: 'i18n/lang.js', to: 'ChatPane / TermPane', required: ['lang'] },
  [HM_EVENTS.VIBE]: { detail: '{ vibe }', from: 'lib/vibe.js / demo frame', to: 'MissionReceiptSheet', required: ['vibe'] },
  [HM_EVENTS.SOUND]: { detail: '{ enabled }', from: 'SettingsPane / demo frame', to: 'lib/soundFx.js', required: ['enabled'] },
  [HM_EVENTS.FX_BURST]: { detail: '{ kind, combo?, x?, y? }', from: 'lib/vibe.js', to: 'FxLayer', required: ['kind'] },
  [HM_EVENTS.SNIPPET_BARS]: { detail: null, from: 'SettingsPane', to: 'snippet-bar consumers' },
  [HM_EVENTS.PILOT_PROFILE]: { detail: '{ profile }', from: 'PipelinePanel', to: 'ChatPane', required: ['profile'] },
})

/**
 * `required` に宣言されたキー（購読側が必須で読む `detail` のキー）を返す。
 *
 * `detail: null` のイベントは `[]` を返す（detail を運ばないので必須キーは無い）。
 * メタを持たない名前（`HM_EVENTS.OPEN_INBOX`）と未登録の名前は `emitHmEvent` と
 * 同じく throw する（生文字列の流入を実行時に見つけるため）。
 *
 * 送信側の実リテラルと全キーが揃っているかは `contracts.test.js` が静的走査で確かめる。
 *
 * @param {string} name `HM_EVENTS` の値
 * @returns {string[]} 必須キー（宣言が無ければ空配列）
 */
export function requiredKeys(name) {
  if (!Object.prototype.hasOwnProperty.call(HM_EVENT_META, name)) {
    throw new Error(`Unknown hm event: ${String(name)}`)
  }
  const list = HM_EVENT_META[name].required
  return Array.isArray(list) ? [...list] : []
}

/**
 * 契約済みイベントを `window` へ送る。
 *
 * `detail` を渡すと `CustomEvent`、渡さなければ `Event` になる（従来の使い分けを保つ）。
 * DOM の無い環境（`node --test`）では何もせず `false` を返す。未登録の名前は
 * 静かに素通りさせず throw する（生文字列の流入を実行時に見つけるため）。
 *
 * @param {string} name `HM_EVENTS` の値
 * @param {unknown} [detail] `CustomEvent.detail`
 * @returns {boolean} 実際に送れたか
 */
export function emitHmEvent(name, detail) {
  if (!Object.prototype.hasOwnProperty.call(HM_EVENT_META, name)) {
    throw new Error(`Unknown hm event: ${String(name)}`)
  }
  const target = typeof window !== 'undefined' ? window : null
  if (!target || typeof target.dispatchEvent !== 'function') return false
  const carriesDetail = detail !== undefined && HM_EVENT_META[name].detail !== null
  target.dispatchEvent(carriesDetail ? new CustomEvent(name, { detail }) : new Event(name))
  return true
}

/**
 * 契約済みイベントを購読する。戻り値を呼ぶと解除できる（`useEffect` の後片付け用）。
 *
 * @param {string} name `HM_EVENTS` の値
 * @param {(event: Event) => void} handler
 * @returns {() => void} 解除関数
 */
export function onHmEvent(name, handler) {
  if (!Object.prototype.hasOwnProperty.call(HM_EVENT_META, name)) {
    throw new Error(`Unknown hm event: ${String(name)}`)
  }
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
  window.addEventListener(name, handler)
  return () => window.removeEventListener(name, handler)
}
