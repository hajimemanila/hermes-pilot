/**
 * タスク詳細シートの表示用の純関数（SPEC-PILOT-V8 §V8-B3）。
 *
 * カンバンの `task_events` は worker の `heartbeat` で埋まる。1 件ずつ並べると
 * タイムラインが heartbeat だけで埋まり、本当に見たい `created` / `claimed` /
 * `completed` が押し出される。ここでは**連続する** heartbeat を 1 行に畳む。
 */

/**
 * イベント列の `kind`（辞書キーに使う）。
 * @param {object} e イベント
 * @returns {string} kind（無ければ空文字）
 */
export function eventKind(e) {
  return String(e?.kind ?? '')
}

/**
 * 連続する `heartbeat` を 1 件に畳む。
 *
 * - 入力は `kanban.task()` の `events`（**新しい順**）を想定する
 * - `{ kind: 'heartbeat', count, at, firstAt }` を返す（`at` が最新、`firstAt` が最古）
 * - 別種のイベントを跨いで合算しない（間に `claimed` などが挟まれば別グループ）
 * - 元の配列・要素は書き換えない（React の再描画で差分が出ないように）
 *
 * @param {Array<object>} [events] イベント（新しい順）
 * @returns {Array<object>} 畳んだイベント（新しい順・同じ長さ以下）
 */
export function collapseTaskEvents(events = []) {
  /** @type {Array<object>} */
  const out = []
  /** @type {{kind: string, count: number, at: number, firstAt: number}|null} */
  let run = null
  for (const e of events ?? []) {
    if (!e) continue
    const at = Number(e.at ?? 0)
    if (eventKind(e) !== 'heartbeat') {
      out.push(e)
      run = null
      continue
    }
    if (run && out[out.length - 1] === run) {
      run.count += 1
      // 新しい順なので、先に来た方が `at`（最新）、後から来た方が `firstAt`（最古）
      run.firstAt = at
      continue
    }
    run = { kind: 'heartbeat', count: 1, at, firstAt: at }
    out.push(run)
  }
  return out
}

/* ------------------------------------------------------------------------- */
/* Coherence 提案バナー（SPEC-COHERENCE §3.6 / D83）                          */
/* ------------------------------------------------------------------------- */

/**
 * バナーを出す閾値（`coherence.js` の `coherenceAlertFrom` と同じ規則）。
 *
 * `hardFailCount > 0 || hotspotCount >= 1 || softSignalCount >= 3`。
 * 「どれか 1 つでも該当」なので、`hotspots` の下限だけ 1 と書いておく。
 */
export const COHERENCE_THRESHOLDS = Object.freeze({ hotspotCount: 1, softSignalCount: 3 })

/** 数値化（不正は 0）。 */
function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 予兆アラートを 1 つの形へ正規化する。
 *
 * 入力は 2 系統を受ける:
 *  - `GET /api/coherence/report` の生レポート（`summary` を持つ）
 *  - パイプライン完走レポートの `coherence_alert`（`{ summary, recommendedSweep, highlights }`）
 *
 * `summary` が無い・数値でない場合は `alert: false`（＝ バナーを出さない）。
 *
 * @param {unknown} raw レポート（どちらの形でもよい）
 * @returns {{alert: boolean, summary: {hardFailCount: number, softSignalCount: number, hotspotCount: number},
 *            recommendedSweep: string|null, highlights: string[]}} 正規化結果
 */
export function normalizeCoherenceAlert(raw) {
  const src = raw && typeof raw === 'object' ? /** @type {any} */ (raw) : null
  const alert =
    src?.coherence_alert && typeof src.coherence_alert === 'object' ? src.coherence_alert : src ?? {}
  const summary = alert?.summary && typeof alert.summary === 'object' ? alert.summary : {}
  const counts = {
    hardFailCount: num(summary.hardFailCount),
    softSignalCount: num(summary.softSignalCount),
    hotspotCount: num(summary.hotspotCount),
  }
  const rawHighlights =
    Array.isArray(alert?.highlights) && alert.highlights.length
      ? alert.highlights
      : [
          ...(Array.isArray(alert?.hardFails) ? alert.hardFails : []),
          ...(Array.isArray(alert?.softSignals) ? alert.softSignals : []),
        ].map((issue) => (typeof issue === 'string' ? issue : (issue?.message ?? issue?.rule ?? '')))
  const highlights = rawHighlights
    .map((h) => String(h ?? '').trim())
    .filter(Boolean)
    .slice(0, 3)
  const sweep = typeof alert?.recommendedSweep === 'string' ? alert.recommendedSweep : null
  const hit =
    counts.hardFailCount > 0 ||
    counts.hotspotCount >= COHERENCE_THRESHOLDS.hotspotCount ||
    counts.softSignalCount >= COHERENCE_THRESHOLDS.softSignalCount
  return { alert: hit, summary: counts, recommendedSweep: sweep, highlights }
}

/**
 * 閉じた記録の署名。件数と推奨スイープが変わったら**別のアラート**として出し直す
 * （直したのに出続ける／悪化したのに隠れたまま、の両方を防ぐ）。
 *
 * @param {{summary: object, recommendedSweep: string|null}} alert 正規化済みアラート
 * @returns {string} 署名
 */
export function coherenceSignature(alert) {
  const s = alert?.summary ?? {}
  return [num(s.hardFailCount), num(s.softSignalCount), num(s.hotspotCount), alert?.recommendedSweep ?? '-'].join(':')
}

/**
 * `localStorage` の生値を読む（壊れていても `null`）。
 *
 * @param {unknown} raw `getItem` の戻り値
 * @returns {{signature: string, at: number}|null} 記録
 */
export function parseCoherenceDismissed(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const signature = typeof parsed.signature === 'string' ? parsed.signature : ''
    if (!signature) return null
    return { signature, at: num(parsed.at) }
  } catch {
    return null
  }
}

/**
 * バナーを出すかどうか（純関数）。
 *
 * @param {unknown} report レポート（`/api/coherence/report` か完走レポート）
 * @param {unknown} dismissedRaw `localStorage` の生値
 * @returns {{show: boolean, alert: boolean, dismissed: boolean, summary: object,
 *            recommendedSweep: string|null, highlights: string[], signature: string}} 判定
 */
export function coherenceBannerView(report, dismissedRaw) {
  const normalized = normalizeCoherenceAlert(report)
  const signature = coherenceSignature(normalized)
  const dismissed = parseCoherenceDismissed(dismissedRaw)
  const hidden = Boolean(dismissed && dismissed.signature === signature)
  return {
    show: normalized.alert && !hidden,
    alert: normalized.alert,
    dismissed: hidden,
    summary: normalized.summary,
    recommendedSweep: normalized.recommendedSweep,
    highlights: normalized.highlights,
    signature,
  }
}

/**
 * 閉じた記録を書くための値（`JSON.stringify` 前のオブジェクト）。
 *
 * @param {string} signature `coherenceSignature()` の戻り値
 * @param {number} [now] 時刻（テスト用）
 * @returns {{signature: string, at: number}} 保存する値
 */
export function coherenceDismissRecord(signature, now = Date.now()) {
  return { signature: String(signature ?? ''), at: Number(now) || 0 }
}

/* ------------------------------------------------------------------------- */
/* SPEC アーカイブの表示（SPEC-COHERENCE §3.6 / D84）                         */
/* ------------------------------------------------------------------------- */

/**
 * SPEC 一覧をアクティブ / アーカイブへ分ける（クライアント側の保険。
 * サーバが `archivedSpecs` を返さない旧ブリッジでも `archived` フラグで分けられる）。
 *
 * @param {Array<object>} list `listSpecs()` 相当
 * @returns {{active: Array<object>, archived: Array<object>}} 分割結果（順序は保つ）
 */
export function splitSpecsByArchive(list) {
  const active = []
  const archived = []
  for (const spec of Array.isArray(list) ? list : []) {
    if (spec?.archived) archived.push(spec)
    else active.push(spec)
  }
  return { active, archived }
}

/**
 * Launchpad に出す SPEC の並び（`Show archived` の状態で切り替える）。
 *
 * 既定（`showArchived === false`）はアクティブだけ。ON のときは mtime の新しい順で混ぜる
 * （アーカイブは「見たいときだけ」なので、既定の並びに混ぜない）。
 *
 * @param {{active?: Array<object>, archived?: Array<object>}} parts 分割済みの一覧
 * @param {boolean} showArchived アーカイブも出すか
 * @returns {Array<object>} 表示する一覧
 */
export function specPickerList(parts, showArchived = false) {
  const active = Array.isArray(parts?.active) ? parts.active : []
  const archived = Array.isArray(parts?.archived) ? parts.archived : []
  if (!showArchived) return active
  return [...active, ...archived].sort(
    (a, b) => Number(b?.mtime ?? 0) - Number(a?.mtime ?? 0) || String(a?.path ?? '').localeCompare(String(b?.path ?? '')),
  )
}
