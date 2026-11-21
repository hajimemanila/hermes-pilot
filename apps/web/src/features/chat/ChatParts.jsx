/**
 * チャットの表示パーツ（`ChatPane.jsx` から切り出し）。
 *
 * 会話 1 本の描画で使う「本文 Markdown / ツール行 / 統合レポートカード /
 * 過去セッション一覧 / 入力欄の自動伸長」だけを持つ。会話全体の状態（ソケット・送信・
 * スクロール・添付）は `ChatPane.jsx` 側の責務のまま置く。
 */

import React, { useMemo } from 'react'
import { DEFAULT_PROFILE } from '../../lib/profile.js'
import { isReadonlySession } from '../../lib/chatResume.js'
import { renderMarkdown } from '../../lib/markdown.js'
import { api } from '../../api.js'
import { composerHeight } from '../../lib/composerSize.js'
import { reportBodyFor, reportSummaryLine } from '../../lib/chatReports.js'
import { unreadRepliesLabel } from '../../lib/sessionUnread.js'
import { Icon, RefreshButton, Sheet, fmtDateTime, relTime } from '../../components/Ui.jsx'
import { haptic } from '../../lib/haptic.js'
import { t } from '../../i18n/lang.js'
import { sep } from '../../lib/format.js'

/** 入力欄を内容に合わせて伸ばす（枠の分を足さないと 2px 溢れて縦棒が出る）。 */
export function fitComposer(el, cap = 120) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${composerHeight({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, offsetHeight: el.offsetHeight, cap })}px`
}

/** ツール実行行を直近のアシスタント発話へ畳み込んで保持する。 */
export function commitProgressToBlocks(prev, toolRows) {
  if (!toolRows?.length) return prev
  const closed = toolRows.map((r) => ({ ...r, done: true }))
  const next = prev.slice()
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i].role === 'assistant') {
      next[i] = { ...next[i], tools: [...(next[i].tools ?? []), ...closed] }
      return next
    }
    if (next[i].role === 'user') break
  }
  return [...next, { role: 'assistant', text: '', open: false, tools: closed, at: Date.now() }]
}

/**
 * アシスタント本文（Markdown）を描画する。
 * パースは本文とハンドラが変わったときだけ走らせる（思考中カードの再描画で毎回パースしない）。
 */
export function MarkdownBody({ text, onCopyCode, copyLabel }) {
  const node = useMemo(
    () => renderMarkdown(text, { onCopyCode, copyLabel }),
    [text, onCopyCode, copyLabel],
  )
  return node
}

/**
 * パイプライン統合レポートのリッチカード（SPEC-PILOT-V4 §3.3 ② / D20③）。
 *
 * タイムライン上で「統合 Markdown サマリ」を折りたたみ可能なカードとして出し、
 *  - 💬 次の一手を相談 … 相談文を入力欄へ下書きセット（誤送信しない・1 タップで確認送信）
 *  - 📋 ボードを見る … `hm:open-board` で Tasks タブの該当ボードへ移る
 * の 2 つの導線を持つ。`kind: 'pipeline'` 以外の報告（レビュー完了 1 行）は従来どおり。
 */
export function PipelineReportCard({ report, open, onToggle, onDiscuss, onOpenBoard, onCopyCode, onReceipt }) {
  const halted = String(report?.status ?? '') === 'halted'
  const body = reportBodyFor(report)
  return (
    <div className={`msg report-card${halted ? ' is-halted' : ''}`} title={fmtDateTime(report?.at)}>
      <button type="button" className="report-card-head" onClick={onToggle} aria-expanded={Boolean(open)}>
        <span className="report-card-icon" aria-hidden="true">
          {halted ? '⚠️' : '🎉'}
        </span>
        <span className="report-card-title">{report?.label || t('chat.pipelineReport')}</span>
        <span className={`report-chip ${halted ? 'halted' : 'done'}`}>
          {halted ? t('chat.reportHalted') : t('chat.reportDone')}
        </span>
        <span className="report-card-time">{relTime(report?.at)}</span>
        <span className="report-card-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <div className="report-card-body">
          <MarkdownBody text={body} onCopyCode={onCopyCode} copyLabel={t('chat.copy')} />
        </div>
      ) : (
        <div className="report-card-summary">{reportSummaryLine(report)}</div>
      )}
      <div className="report-card-actions">
        <button type="button" className="report-card-btn primary" onClick={onDiscuss}>
          {t('chat.discussNextSteps')}
        </button>
        <button type="button" className="report-card-btn" onClick={onReceipt}>
          {t('receipt.open')}
        </button>
        {report?.board ? (
          <button type="button" className="report-card-btn" onClick={onOpenBoard}>
            {t('chat.openBoard')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** ツール行の一覧（タップで省略前の全文を展開）。 */
export function ToolRows({ rows, prefix, expandedMap, onToggle }) {
  return (
    <ol className="tool-rows">
      {rows.map((r, idx) => {
        const key = `${prefix}-${r.id || ''}-${idx}`
        const expanded = Boolean(expandedMap[key])
        const text = expanded ? r.full || r.detail : r.detail || r.full
        const hasMore = Boolean(r.full && r.full !== r.detail)
        return (
          <li
            key={key}
            className={`${r.done ? 'done' : 'run'}${expanded ? ' expanded' : ''}${hasMore ? ' tappable' : ''}`}
            onClick={
              hasMore
                ? (e) => {
                    e.stopPropagation()
                    onToggle(key)
                  }
                : undefined
            }
          >
            <span className="tool-state" aria-hidden="true">
              {r.done ? '✓' : <span className="tool-spin" />}
            </span>
            <span className="tool-name">{r.name}</span>
            {text ? <span className="tool-detail">{text}</span> : null}
            {r.done ? (
              <span className="tool-ms">{r.ms ? `${(r.ms / 1000).toFixed(1)}s` : ''}</span>
            ) : (
              <span className="tool-ms">…</span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * ドロワーを開いたときの自動リフレッシュの最短間隔（SPEC-PILOT-V4 §3.1 / D22②・1.5s スロットル）。
 * 開け閉めを繰り返しても `/api/sessions` を叩きすぎないようにする。
 */
export const DRAWER_REFRESH_THROTTLE_MS = 1500

/**
 * チャットタブ。ブリッジの /ws/chat 経由で Hermes の JSON-RPC（/api/ws）を話す。
 *
 * 添付は Hermes 自身の口を使う（ブリッジ側にストレージを持たない）:
 *   - 画像: `image.attach_bytes {session_id, content_base64, filename}` … 次のターンに載る
 *   - ファイル: `file.attach {session_id, data_url, name}` … ワークスペースに置かれ `@file:` 参照が返る
 * 送信時にまとめて attach → prompt.submit する（セッション再作成に強い）。
 *
 * 定型スニペットは `GET /api/snippets`（組み込み + マイ）。タップで挿入、長押しで即送信。
 */
/**
 * セッション一覧（会話ドロワーの中身）。
 *
 * 1 ペインでは `Sheet` の中、820px 以上の 2 カラムでは左カラムの上に**同じもの**を出す
 * （行の見た目・バッジ・未読は現行のまま・SPEC-ver-0-2-1 §2.3）。中身を 2 箇所へ
 * 書き分けないため、ここに 1 つだけ置いて props で受け取る。
 */
export function ChatSessionList({
  sessions,
  sessionBadges,
  pipelineSessionIds,
  readonlySessionId,
  orphanReports,
  refreshing,
  markDisabled,
  onRefresh,
  onMarkAllRead,
  onOpenOrphan,
  onNewChat,
  onOpenSession,
}) {
  return (
    <>
      {/* ドロワー上部の操作バー（D22③）: ↻ 更新 / ✓ すべて既読 */}
      <div className="drawer-actions">
        <RefreshButton
          variant="btn"
          label={t('chat.drawerRefresh')}
          busy={refreshing}
          onRefresh={onRefresh}
        />
        <button
          type="button"
          className="btn drawer-mark-read"
          disabled={markDisabled}
          onClick={() => {
            haptic('tap')
            onMarkAllRead()
          }}
        >
          <span aria-hidden="true">✓</span> {t('chat.markAllRead')}
        </button>
      </div>
      {/* 会話一覧に宛先が無い完了レポート（worker/UI セッション宛て）は
          専用行として先頭に出す。タップで該当 repo の会話を開いて相談文を置く。 */}
      {orphanReports.map((u) => (
        <button
          key={`report:${u.sessionId}`}
          className="row drawer-report-row"
          title={t('chat.unreadReportTitle')}
          onClick={() => onOpenOrphan(u)}
        >
          <span className="row-main">
            <span className="row-title">
              <span aria-hidden="true">📋</span> {u.label || t('chat.pipelineReport')}
            </span>
            <span className="row-sub">
              {u.board ? `${u.board} · ` : ''}
              {t('chat.reportNoSession')}
            </span>
          </span>
          <span className="row-badge done" aria-hidden="true">
            {'!'}
          </span>
        </button>
      ))}
      <button className="row" onClick={onNewChat}>
        <span className="row-main">
          <span className="row-title">{t('chat.newChat')}</span>
          <span className="row-sub">{t('chat.newChatRowSub')}</span>
        </span>
        <Icon name="plus" size={16} />
      </button>
      {sessions.map((s) => {
        const foreign = s.profile && s.profile !== DEFAULT_PROFILE
        const key = `${s.profile ?? 'default'}:${s.id}`
        // 行のバッジは純関数（`lib/sessionUnread.js`）で決める。表示中・実行中・
        // 未読の完了報告（件数）・返信の新着（NEW / +N）を 1 行に出す（D16②）。
        const badge = sessionBadges[key] ?? {
          isActive: false,
          isRunning: false,
          unreadReports: 0,
          unreadReplies: 0,
        }
        const isRo = isReadonlySession(s, readonlySessionId)
        const replyLabel = unreadRepliesLabel(badge.unreadReplies)
        return (
          <button
            key={key}
            className={`row${badge.isActive ? ' on' : ''}${isRo ? ' ro' : ''}${
              badge.unreadReports || pipelineSessionIds.has(String(s.id)) ? ' has-report' : ''
            }`}
            title={
              badge.unreadReports
                ? t('chat.unreadReportTitle')
                : replyLabel
                  ? t('chat.newReplyTitle')
                  : isRo
                    ? t('chat.readonlyTitle')
                    : t('chat.resumableTitle')
            }
            onClick={() => onOpenSession(s)}
          >
            <span className="row-main">
              <span className="row-title">
                {pipelineSessionIds.has(String(s.id)) ? (
                  <span className="row-report-mark" title={t('chat.pipelineReport')} aria-label={t('chat.pipelineReport')}>
                    📋
                  </span>
                ) : null}
                {s.title || s.id}
              </span>
              <span className="row-sub session-meta">
                <span
                  className={`row-mode ${isRo ? 'ro' : 'resumable'}`}
                  title={isRo ? t('chat.readonlyTitle') : t('chat.resumableTitle')}
                >
                  {isRo ? t('chat.readonlyShort') : t('chat.resumableShort')}
                </span>
                {foreign ? (
                  <span className="prof-chip on">{s.profile}</span>
                ) : null}
                <span>
                  {s.source ?? 'cli'} ${sep()} {s.message_count ?? 0} msg ${sep()} {relTime((s.started_at ?? 0) * 1000)}
                  {s.is_active ? t('chat.runningSuffix') : ''}
                </span>
              </span>
            </span>
            {badge.isRunning ? (
              <span
                className="row-dot running"
                title={t('chat.runningTitle')}
                aria-label={t('chat.runningTitle')}
              />
            ) : null}
            {badge.unreadReports ? (
              <span
                className="row-badge done"
                title={t('chat.unreadReportTitle')}
                aria-label={t('chat.reportAria')}
              >
                {badge.unreadReports}
              </span>
            ) : null}
            {replyLabel ? (
              <span className="row-badge new" title={t('chat.newReplyTitle')}>
                {replyLabel}
              </span>
            ) : null}
            <Icon name="chevron" size={16} />
          </button>
        )
      })}
    </>
  )
}
