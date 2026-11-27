/**
 * `/api/*` 契約レジストリ（SPEC-COHERENCE §3 COH-2 / D81）。
 *
 * 目的: Web が呼ぶ `/api/*`・ブリッジの `server.js` が受ける `/api/*`・デモの
 * `mockApi.js` が答える `/api/*` を **1 枚の表**にまとめ、片側だけ増えた状態
 * （＝呼んでも 404・デモでは空の入れ物）を機械で検出できるようにする。
 *
 * 約束（契約の意味）:
 * - `mocked`      … デモ（`apps/web/src/demo/mockApi.js`）が明示ハンドラで答える。
 * - `bridge-only` … 実ブリッジ専用（認証・ログ・WebSocket・非 JSON 応答・書き込み系の一部）。
 *                   デモは答えない（画面側のデモ分岐や img/iframe 差し替えが担う）。
 * - `deprecated`  … まだ受け付けるが、現行の Web からは呼ばない。`deprecatedBy` に移行先。
 *
 * この表は決定的な純データで、追加・削除は「Web／server.js／mockApi.js を直したときだけ」行う。
 * `apps/bridge/test/routeContracts.test.js` が 3 者との一致を検査する。
 */

/**
 * 1 ルート分の契約。
 *
 * @typedef {object} ApiRoute
 * @property {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'WS'} method HTTP メソッド（`WS` は `/api/ws`）
 * @property {string} pattern `/api/...`。`:name` は 1 セグメント、`*` は残り全部のワイルドカード
 * @property {'mocked'|'bridge-only'|'deprecated'} demo デモ対応の区分
 * @property {string} [deprecatedBy] `deprecated` のときの移行先パス
 * @property {string} [note] 補足（人が読む。機械判定には使わない）
 */

/** @type {ApiRoute[]} */
export const API_ROUTES = [
  // --- 基本情報 -------------------------------------------------------------
  { method: 'GET', pattern: '/api/me', demo: 'bridge-only', note: '認証済みかの判定とバージョン' },
  { method: 'GET', pattern: '/api/overview', demo: 'mocked', note: 'ダッシュボード（`paused` を含む）' },
  { method: 'GET', pattern: '/api/capabilities', demo: 'bridge-only', note: 'OS・サービス管理・CLI の有無' },
  { method: 'GET', pattern: '/api/ws', demo: 'bridge-only', note: 'WebSocket（JSON-RPC）' },
  { method: 'WS', pattern: '/api/ws', demo: 'bridge-only', note: 'WebSocket アップグレード' },

  // --- 認証 -----------------------------------------------------------------
  { method: 'GET', pattern: '/api/auth/pairing', demo: 'mocked', note: 'QR ペアリング（ワンタイムコード）' },
  { method: 'POST', pattern: '/api/auth/login', demo: 'bridge-only', note: 'トークン交換' },

  // --- リポジトリとボード ---------------------------------------------------
  { method: 'GET', pattern: '/api/repos', demo: 'mocked' },
  { method: 'POST', pattern: '/api/repos', demo: 'bridge-only', note: '追加・scanDirs 更新（書き込み）' },
  { method: 'POST', pattern: '/api/repos/scan', demo: 'bridge-only' },
  { method: 'POST', pattern: '/api/repos/new', demo: 'mocked', note: '新規プロジェクト作成（mkdir + git init + board）' },
  { method: 'POST', pattern: '/api/repos/:id/board', demo: 'bridge-only' },
  { method: 'DELETE', pattern: '/api/repos/:id', demo: 'bridge-only' },

  // --- Spec Launchpad -------------------------------------------------------
  { method: 'GET', pattern: '/api/specs', demo: 'mocked' },
  { method: 'GET', pattern: '/api/specs/content', demo: 'mocked' },
  { method: 'GET', pattern: '/api/specs/reports', demo: 'mocked' },
  { method: 'POST', pattern: '/api/specs/launch', demo: 'mocked' },

  // --- 整合性診断 -----------------------------------------------------------
  { method: 'GET', pattern: '/api/coherence/report', demo: 'mocked', note: 'Layer 1 診断結果' },
  { method: 'POST', pattern: '/api/coherence/approve', demo: 'bridge-only', note: 'Layer 2 チェッカーを許可リストへ登録' },
  { method: 'POST', pattern: '/api/coherence/revoke', demo: 'bridge-only', note: 'Layer 2 チェッカーの許可を取り消す' },

  // --- パイプライン ---------------------------------------------------------
  { method: 'GET', pattern: '/api/pipeline/status', demo: 'mocked' },
  { method: 'POST', pattern: '/api/pipeline/profile', demo: 'mocked' },
  { method: 'PUT', pattern: '/api/pipeline/profile', demo: 'mocked' },
  { method: 'POST', pattern: '/api/pipeline/optimize', demo: 'mocked' },

  // --- Architect ------------------------------------------------------------
  { method: 'GET', pattern: '/api/architect/config', demo: 'mocked' },
  { method: 'PUT', pattern: '/api/architect/config', demo: 'mocked' },
  { method: 'POST', pattern: '/api/architect/config', demo: 'mocked' },
  { method: 'POST', pattern: '/api/architect/seed', demo: 'mocked' },
  { method: 'GET', pattern: '/api/architect/jobs', demo: 'mocked' },
  { method: 'POST', pattern: '/api/architect/jobs/:id/dismiss', demo: 'mocked' },

  // --- カンバン -------------------------------------------------------------
  { method: 'GET', pattern: '/api/boards', demo: 'mocked' },
  { method: 'GET', pattern: '/api/boards/:board/preview', demo: 'mocked', note: 'ボード成果物のプレビュー情報' },
  { method: 'GET', pattern: '/api/boards/:board/preview-files/*', demo: 'bridge-only', note: '同一オリジン静的プレビュー配信' },
  { method: 'GET', pattern: '/api/boards/:board/tasks', demo: 'mocked' },
  { method: 'POST', pattern: '/api/boards/:board/tasks', demo: 'mocked', note: 'クイック起票' },
  { method: 'GET', pattern: '/api/boards/:board/tasks/:id', demo: 'mocked' },
  { method: 'GET', pattern: '/api/boards/:board/tasks/:id/diff', demo: 'mocked' },
  { method: 'GET', pattern: '/api/boards/:board/tasks/:id/worker', demo: 'mocked' },
  { method: 'POST', pattern: '/api/boards/:board/tasks/:id/comment', demo: 'mocked' },
  { method: 'POST', pattern: '/api/boards/:board/tasks/:id/close', demo: 'mocked' },
  { method: 'POST', pattern: '/api/boards/:board/tasks/:id/unblock', demo: 'mocked' },
  { method: 'POST', pattern: '/api/boards/:board/tasks/:id/abort', demo: 'mocked' },

  // --- レビュー（赤ペン）----------------------------------------------------
  { method: 'GET', pattern: '/api/review', demo: 'mocked' },
  { method: 'GET', pattern: '/api/review/feed', demo: 'mocked' },
  { method: 'GET', pattern: '/api/review/chat-reports', demo: 'mocked' },
  { method: 'GET', pattern: '/api/review/chat-report', demo: 'mocked' },
  { method: 'GET', pattern: '/api/review/targets', demo: 'mocked' },
  { method: 'GET', pattern: '/api/review/library', demo: 'mocked' },
  { method: 'GET', pattern: '/api/review/library/file', demo: 'bridge-only', note: '画像バイト列（img 直参照）' },
  { method: 'POST', pattern: '/api/review/annotation/new', demo: 'mocked', note: '画像から注釈タスクを 1 件作る' },
  {
    method: 'POST',
    pattern: '/api/review/from-image',
    demo: 'deprecated',
    deprecatedBy: '/api/review/annotation/new',
    note: '旧経路。配信済み dist を掴んだ端末のために受け続ける',
  },
  { method: 'GET', pattern: '/api/review/:id/session', demo: 'mocked' },
  { method: 'GET', pattern: '/api/review/:id/worker', demo: 'mocked' },
  { method: 'GET', pattern: '/api/review/:id/image', demo: 'bridge-only', note: 'PNG バイト列（img 直参照）' },
  { method: 'GET', pattern: '/api/review/:id/thumb/*', demo: 'bridge-only', note: 'サムネイル画像（img 直参照）' },
  { method: 'GET', pattern: '/api/review/:id/sheet', demo: 'bridge-only', note: 'シート HTML（iframe 直参照）' },
  { method: 'GET', pattern: '/api/review/:id/mock', demo: 'bridge-only', note: 'Autopilot 触れるモック HTML（厳格 sandbox CSP）' },
  { method: 'GET', pattern: '/api/review/:id/view', demo: 'bridge-only', note: '単体タブ用ラッパー HTML' },
  { method: 'GET', pattern: '/api/review/:id/data', demo: 'mocked', note: 'sheet.json（ネイティブフォーム用）' },
  { method: 'GET', pattern: '/api/review/:id/annotation', demo: 'mocked' },
  { method: 'POST', pattern: '/api/review/:id/annotation', demo: 'mocked' },
  { method: 'POST', pattern: '/api/review/:id/answer', demo: 'mocked' },
  { method: 'POST', pattern: '/api/review/:id/remix', demo: 'mocked', note: 'Autopilot 左スワイプでの別案再生成要求' },
  { method: 'POST', pattern: '/api/review/:id/reopen', demo: 'mocked' },
  { method: 'POST', pattern: '/api/review/:id/approve', demo: 'mocked' },

  // --- 会話・状態 -----------------------------------------------------------
  { method: 'GET', pattern: '/api/sessions', demo: 'mocked' },
  { method: 'GET', pattern: '/api/sessions/:id/transcript', demo: 'mocked' },
  { method: 'GET', pattern: '/api/live', demo: 'mocked' },
  { method: 'GET', pattern: '/api/asset-log', demo: 'bridge-only' },
  { method: 'GET', pattern: '/api/inbox', demo: 'mocked' },
  { method: 'GET', pattern: '/api/usage', demo: 'mocked' },
  { method: 'GET', pattern: '/api/telemetry/receipt', demo: 'mocked' },
  { method: 'GET', pattern: '/api/search', demo: 'mocked' },
  { method: 'GET', pattern: '/api/discord/session', demo: 'mocked', note: 'Discord スレッドへのリンク' },

  // --- 実行制御（緊急停止）--------------------------------------------------
  { method: 'POST', pattern: '/api/gateway/:action', demo: 'mocked', note: 'pause / resume / その他ゲートウェイ操作' },

  // --- ゴミ整理（D92・SPEC-RELIABILITY-GUARD RG-3）---------------------------
  {
    method: 'POST',
    pattern: '/api/boards/:board/tasks/bulk-archive',
    demo: 'mocked',
    note: '一括アーカイブ（running はスキップ）',
  },
  {
    method: 'POST',
    pattern: '/api/specs/archive',
    demo: 'mocked',
    note: 'SPEC をヘッダ追記でアーカイブ退避（ファイルは消さない）',
  },
  {
    method: 'POST',
    pattern: '/api/emergency/stop-all',
    demo: 'mocked',
    note: 'Stop every running kanban task (ESTOP + bulk abort)',
  },

  // --- 定型文・メモ・ログ ---------------------------------------------------
  { method: 'GET', pattern: '/api/snippets', demo: 'mocked' },
  { method: 'PUT', pattern: '/api/snippets', demo: 'mocked' },
  { method: 'GET', pattern: '/api/snippets/term', demo: 'mocked' },
  { method: 'PUT', pattern: '/api/snippets/term', demo: 'mocked' },
  { method: 'GET', pattern: '/api/memos', demo: 'mocked' },
  { method: 'POST', pattern: '/api/memos', demo: 'mocked' },
  { method: 'PATCH', pattern: '/api/memos/:id', demo: 'mocked' },
  { method: 'DELETE', pattern: '/api/memos/:id', demo: 'mocked' },
  { method: 'POST', pattern: '/api/client-error', demo: 'mocked' },
  { method: 'GET', pattern: '/api/logs', demo: 'mocked', note: 'デモは固定のログ行を返す' },
  { method: 'GET', pattern: '/api/audit', demo: 'mocked' },
]

/** デモ対応の区分（3 値以外を書かないための一覧）。 */
export const DEMO_KINDS = ['mocked', 'bridge-only', 'deprecated']

/** HTTP メソッドの語彙。 */
export const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'WS']

/**
 * パスを比較用に正規化する（クエリ・ハッシュ・末尾スラッシュ・連続スラッシュを吸収）。
 *
 * 例: `/api/boards/mobile/tasks/?limit=60#x` → `/api/boards/mobile/tasks`
 *
 * @param {unknown} raw 生のパス（クエリ付き可）
 * @returns {string} 正規化したパス（`/api/...`）。空入力は空文字
 */
export function normalizeApiPath(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const cut = text.split(/[?#]/)[0]
  const withSlash = cut.startsWith('/') ? cut : `/${cut}`
  const collapsed = withSlash.replace(/\/{2,}/g, '/')
  if (collapsed === '/') return '/'
  return collapsed.replace(/\/+$/, '')
}

/**
 * パターンを正規表現へ変換する（`:name` は 1 セグメント、`*` は残り全部）。
 *
 * @param {string} pattern 契約パターン
 * @returns {RegExp} マッチ用の正規表現（名前付きグループ `p0`…）
 */
export function apiPatternToRegExp(pattern) {
  const norm = normalizeApiPath(pattern)
  const parts = norm.split('/').filter(Boolean)
  const out = []
  const names = []
  parts.forEach((seg, i) => {
    if (seg === '*') {
      names.push(`p${i}`)
      out.push('(.*)')
      return
    }
    if (seg.startsWith(':')) {
      names.push(seg.slice(1))
      out.push('([^/]+)')
      return
    }
    out.push(seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  })
  // `*` は残り全部なので、後続セグメントがあれば正規表現を組み直す
  const source = `^/${out.join('/')}$`
  return { re: new RegExp(source), names }
}

/**
 * メソッドとパスから契約を引く（静的セグメントの多い＝具体的なパターンを優先）。
 *
 * @param {string} method HTTP メソッド（`WS` も可。未指定は `GET`）
 * @param {string} path `/api/...`（クエリ付き可）
 * @returns {(ApiRoute & {params: Record<string, string>})|null} 一致した契約（無ければ `null`）
 */
export function matchApiRoute(method, path) {
  const want = String(method ?? 'GET').trim().toUpperCase() || 'GET'
  const norm = normalizeApiPath(path)
  if (!norm.startsWith('/api/')) return null
  const scored = []
  API_ROUTES.forEach((route, index) => {
    if (route.method !== want) return
    const { re } = apiPatternToRegExp(route.pattern)
    const m = re.exec(norm)
    if (!m) return
    const segs = normalizeApiPath(route.pattern).split('/').filter(Boolean)
    const statics = segs.filter((s) => !s.startsWith(':') && s !== '*').length
    const params = {}
    let group = 0
    for (const seg of segs) {
      if (seg.startsWith(':') || seg === '*') {
        params[seg === '*' ? 'rest' : seg.slice(1)] = m[++group] ?? ''
      }
    }
    scored.push({ route, statics, index, params, wildcard: route.pattern.includes('*') ? 1 : 0 })
  })
  if (!scored.length) return null
  // 具体的（静的セグメントが多い）→ ワイルドカードでない → 表の並び順
  scored.sort((a, b) => b.statics - a.statics || a.wildcard - b.wildcard || a.index - b.index)
  return { ...scored[0].route, params: scored[0].params }
}

/**
 * 契約の一覧を区分で絞る（テストとドキュメント生成用）。
 *
 * @param {'mocked'|'bridge-only'|'deprecated'} kind 区分
 * @returns {ApiRoute[]} 該当する契約
 */
export function listApiRoutes(kind) {
  if (!kind) return [...API_ROUTES]
  return API_ROUTES.filter((r) => r.demo === kind)
}
