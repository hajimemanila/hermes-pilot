/**
 * タイムライン・報告バナー・吹き出しメニュー（`ChatPane.jsx` から切り出し・CSW3-3）。
 *
 * 会話 1 本の「読む側」だけを持つ: 発言の描画（`ChatTimeline`）、進行中ターンと
 * 紐づいた Review ワーカーのカード、オフライン／完了レポート／読み取り専用のバナー
 * （`ChatReportBanner`）、吹き出しの「…」メニュー（`ChatBubbleMenu`）。
 *
 * スクロール位置の操作（ヒット発言への移動・`↓ 最新へ`・バナーの合流）は
 * **このファイルの関数に閉じる**。`ChatPane` は ref を持ち回すだけで、位置を計算しない。
 *
 * 状態（blocks / timeline / 送信 / 会話の切り替え）は `ChatPane.jsx` の責務のまま。
 * ここへ渡すのは 5 つの束（`scroll` / `session` / `feed` / `handlers` / `ui`）だけで、
 * 親側の JSX が 30 個の props 行で膨らまないようにしている。
 */

import React, { useRef, useState } from 'react'
import { Icon, Loader, Sheet, fmtBytes, fmtDateTime, relTime } from '../../components/Ui.jsx'
import { MarkdownBody, PipelineReportCard, ToolRows } from './ChatParts.jsx'
import { recentSessions } from '../../lib/chatResume.js'
import { LATEST_REPORT_ID, isPipelineReport, reportSummaryLine, toEpochMs } from '../../lib/chatReports.js'
import { isWaiting } from '../../lib/reviewView.js'
import { shortenPath } from '../../lib/toolProgress.js'
import { api } from '../../api.js'
import { HM_EVENTS, emitHmEvent } from '../../contracts/events.js'
import { celebrate } from '../../lib/vibe.js'
import { haptic } from '../../lib/haptic.js'
import { t } from '../../i18n/lang.js'

/**
 * スクロール領域を末尾へ送る（`↓ 最新へ` と、統合レポートへの合流が同じ操作を使う）。
 * 描画前（要素が無い）なら false を返し、呼び出し側が state を動かさないようにする。
 */
function scrollMessagesToEnd(listRef) {
  const el = listRef?.current
  if (!el) return false
  el.scrollTop = el.scrollHeight
  return true
}

/** ヒットした発言を画面の上寄りに出す（offsetTop ではなく実測差分で合わせる）。 */
export function scrollToMessage(listRef, mid) {
  const sc = listRef?.current
  if (!sc || !mid) return
  const el = sc.querySelector(`[data-mid="${mid}"]`)
  if (!el) return
  const delta = el.getBoundingClientRect().top - sc.getBoundingClientRect().top
  sc.scrollTop = Math.max(0, sc.scrollTop + delta - 10)
}

/* オフライン・完了レポート・読み取り専用のバナー（Q1=A: 2 カラムでは左の下端へ） */
export function ChatReportBanner({
  showBanner,
  otherUnreads,
  readonly,
  storedRef,
  sidRef,
  listRef,
  markReportsSeen,
  findRepoByPath,
  startSession,
  sessions,
  openSessionSafe,
  profile,
  pilotDefault,
}) {
  return (
    <>

      {/* 切断直後（4秒未満）は出さない */}
      {showBanner ? <div className="banner">{t('chat.recovering')}</div> : null}
      {otherUnreads.length ? (
        <div className="chat-report-banner" role="status">
          <span className="chat-report-banner-text">
            {t('chat.otherReport', {
              label:
                otherUnreads[0].label ||
                otherUnreads[0].taskId ||
                reportSummaryLine(otherUnreads[0], 40) ||
                String(otherUnreads[0].text ?? '').slice(0, 28),
            })}
          </span>
          <button
            type="button"
            className="chat-report-btn primary"
            onClick={() => {
              haptic('tap')
              const u = otherUnreads[0]
              /*
               * 宛先の会話が決まらなかった統合レポート（`__latest__`・§3.2 ②）:
               *  - すでに通常会話を開いている → そのタイムラインへ合流（`reportIdsFor` が載せる）
               *  - まだ開いていない → repo を突き合わせて新しい会話を作る
               * 会話 ID が分かっている通常の報告は従来どおりその会話を開く。
               * **`Open` は移動だけ**（SPEC-enter-enter-discuss-next-ste Q3=A）。相談文を置くのは
               * 到着先のレポートカードの「💬 次の一手を相談」= `discussReport` の役目で、
               * ここで prefill すると「ラベルと動作が違う」「入力欄が勝手に埋まる」になる。
               */
              if (u.sessionId === LATEST_REPORT_ID) {
                const target = storedRef.current ?? sidRef.current
                if (target) {
                  markReportsSeen(LATEST_REPORT_ID)
                  requestAnimationFrame(() => scrollMessagesToEnd(listRef))
                  return
                }
                markReportsSeen(LATEST_REPORT_ID)
                findRepoByPath(u.repoPath).then((matched) => {
                  startSession(profile || pilotDefault, matched ?? null, u.board ? { slug: u.board } : null)
                })
                return
              }
              const found = sessions.find((s) => String(s.id) === u.sessionId)
              openSessionSafe(u.sessionId, null, found?.profile || profile || pilotDefault)
            }}
          >
            {t('chat.open')}
          </button>
          <button
            type="button"
            className="chat-report-btn"
            onClick={() => {
              haptic('tap')
              markReportsSeen(otherUnreads[0].sessionId)
            }}
          >
            {t('chat.seen')}
          </button>
        </div>
      ) : null}
      {readonly ? (
        <div className="banner ro">
          {t('chat.readonly')}
          {readonly.profile
            ? t('chat.readonlyProfileSuffix', { profile: readonly.profile })
            : t('chat.readonlyBoardSuffix')}
        </div>
      ) : null}
    </>
  )
}

/* 吹き出しの「…」メニュー（コピー・メモ・Seed・続きの依頼・引用）。 */
export function ChatBubbleMenu({
  menu,
  onClose,
  notify,
  sid,
  title,
  repo,
  readonly,
  sendText,
  setText,
  taRef,
}) {
  return (
    <Sheet title={t('chat.bubbleMenuTitle')} onClose={onClose}>
      <div className="bubble-menu-preview">{menu.text.slice(0, 180)}</div>
      <div className="pick-list">
        <button
          type="button"
          className="pick-item"
          onClick={async () => {
            try {
              await navigator.clipboard?.writeText?.(menu.text)
              notify?.(t('chat.bubbleCopied'))
            } catch {
              notify?.(t('chat.bubbleCopied'))
            }
            onClose()
          }}
        >
          <span className="pick-main">
            <span className="pick-title">{t('chat.bubbleCopy')}</span>
          </span>
        </button>
        <button
          type="button"
          className="pick-item"
          onClick={async () => {
            const firstLine = menu.text.split('\n').map((s) => s.trim()).find(Boolean) || ''
            await api('/api/memos', {
              method: 'POST',
              body: {
                title: firstLine.slice(0, 60),
                body: menu.text,
                tags: ['clip'],
                kind: 'clip',
                color: menu.role === 'user' ? 'teal' : 'default',
                source: {
                  chatId: sid || undefined,
                  chatTitle: title || undefined,
                  board: repo?.board || undefined,
                  repo: repo?.id || undefined,
                  mid: menu.mid ? String(menu.mid) : undefined,
                },
              },
            })
            emitHmEvent(HM_EVENTS.MEMOS_CHANGED)
            celebrate('approve')
            notify?.(t('chat.bubbleSavedMemo'))
            onClose()
          }}
        >
          <span className="pick-main">
            <span className="pick-title">{t('chat.bubbleSaveMemo')}</span>
          </span>
        </button>
        <button
          type="button"
          className="pick-item"
          onClick={() => {
            const seed = menu.text.slice(0, 600)
            onClose()
            window.dispatchEvent(
              new CustomEvent(HM_EVENTS.OPEN_SEED, {
                detail: { seed, repo: repo?.path, board: repo?.board },
              }),
            )
          }}
        >
          <span className="pick-main">
            <span className="pick-title">{t('chat.bubbleToSeed')}</span>
          </span>
        </button>
      </div>
      {!readonly ? (
        <>
          <div className="list-head" style={{ marginTop: 12 }}>
            {t('chat.bubbleContinueHead')}
          </div>
          <div className="pick-list">
            {[
              { label: t('chat.bubbleSummarize'), key: 'chat.bubbleSummarizePrompt' },
              { label: t('chat.bubbleBrainstorm'), key: 'chat.bubbleBrainstormPrompt' },
              { label: t('chat.bubbleDig'), key: 'chat.bubbleDigPrompt' },
            ].map((act) => (
              <button
                key={act.key}
                type="button"
                className="pick-item"
                onClick={() => {
                  const quote = menu.text.slice(0, 600).replace(/\n+/g, '\n> ')
                  onClose()
                  sendText(t(act.key, { quote }))
                }}
              >
                <span className="pick-main">
                  <span className="pick-title">{act.label}</span>
                </span>
              </button>
            ))}
            <button
              type="button"
              className="pick-item"
              onClick={() => {
                const quote = menu.text.slice(0, 320).replace(/\n+/g, '\n> ')
                setText((cur) => (cur ? `${cur}\n> ${quote}\n\n` : `> ${quote}\n\n`))
                onClose()
                setTimeout(() => taRef.current?.focus(), 60)
              }}
            >
              <span className="pick-main">
                <span className="pick-title">{t('chat.bubbleQuote')}</span>
              </span>
            </button>
          </div>
        </>
      ) : null}
    </Sheet>
  )
}

/**
 * タイムライン本体（両レイアウト共通。右カラムではこれが縦を全部使う）。
 *
 * `scroll` = { listRef, stickRef }（親と共有する ref。`useChatSessions` も同じ箱を使う）
 * `session` = 会話の材料 / `feed` = 表示する内容 / `handlers` = 操作 / `ui` = 表示の切替
 */
export function ChatTimeline({ scroll, session, feed, handlers, ui }) {
  const { listRef, stickRef } = scroll
  const {
    blocks,
    loadingChat,
    connState,
    sessions,
    profile,
    resumeInto,
    sockRef,
    setStoredSid,
    transcriptMeta,
    loadOlderTranscript,
  } = session
  const {
    timeline,
    reports,
    reportOpen,
    setReportOpen,
    isWorking,
    nowTick,
    runStartedAt,
    activeLiveTurn,
    progress,
    thinking,
    thinkingExpanded,
    setThinkingExpanded,
    linkedReview,
    workerFeed,
    usage,
    justSettled,
  } = feed
  const { discussReport, openReportReceipt, openReportBoard, copyCode, toggleToolExpand, onOpenBubbleMenu } = handlers
  const { readonly, expandedTools } = ui
  const [atBottom, setAtBottom] = useState(true)
  // 配列添字ではなく「ブロック実体ごとに一意で安定した key」を作るための記録。
  // mid が無い（ライブ生成中・resume 直後）ブロックは `at` が同値になることがあり、
  // 素朴な `at-<at>` だと key 衝突で React が古い DOM を残す（実測: state 43 件 / DOM 45 件）。
  const blockKeysRef = useRef(new WeakMap())
  const blockKeySeqRef = useRef(0)

  return (
    <>

      {/* 「↓ 最新へ」ピルをスクロール領域の下端に留める箱（spec-chat-jump-pos Q1=A）。
          .chat-scroll の伸長はこの箱が持ち、ピルはこの箱の下端 8px を基準に置く。 */}
      <div className="chat-body">
        <div
          className="chat-scroll"
          ref={listRef}
          onScroll={() => {
            const el = listRef.current
            if (!el) return
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            stickRef.current = near
            setAtBottom(near)
          }}
        >
          {!blocks.length && (loadingChat || connState === 'connecting') ? (
            <Loader label={connState === 'connecting' ? t('chat.connecting') : t('chat.loadingChat')} />
          ) : !blocks.length ? (
            <div className="empty">
              <div>{t('chat.sendToStart')}</div>
              {recentSessions(sessions, profile, 2).length ? (
                <div className="empty-recent" aria-label={t('chat.recentAria')}>
                  <div className="empty-recent-head">{t('chat.recentHead')}</div>
                  {recentSessions(sessions, profile, 2).map((x) => (
                    <button
                      key={x.id}
                      type="button"
                      className="empty-recent-row"
                      title={x.title || x.id}
                      onClick={async () => {
                        const ok = await resumeInto(sockRef.current?.rpc, x.id, x.profile || profile)
                        if (ok?.ok) setStoredSid(x.id)
                      }}
                    >
                      <span className="empty-recent-title">{x.title || x.id}</span>
                      <span className="empty-recent-when">
                        {relTime(toEpochMs(x.updated_at ?? x.started_at))}
                      </span>
                      <span className="empty-recent-mark" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {transcriptMeta?.hasMore && transcriptMeta?.oldestId ? (
            <button
              type="button"
              className="chat-older"
              disabled={transcriptMeta.loadingMore}
              onClick={() => {
                haptic('tap')
                loadOlderTranscript()
              }}
            >
              {transcriptMeta.loadingMore ? t('chat.loadingOlder') : t('chat.loadOlder')}
            </button>
          ) : null}
          {timeline.map((item, itemIdx) => {
            if (item.kind === 'report') {
              const r = item.report
              if (isPipelineReport(r)) {
                // 統合レポートはリッチカード（§3.3 ②）。既定は最新 1 件だけ展開する。
                const ri = reports.findIndex((x) => x.key === r.key)
                const isNewest = ri === reports.length - 1
                const isOpen = r.key in reportOpen ? Boolean(reportOpen[r.key]) : isNewest
                return (
                  <PipelineReportCard
                    key={r.key}
                    report={r}
                    open={isOpen}
                    onToggle={() => {
                      haptic('tap')
                      setReportOpen((prev) => ({ ...prev, [r.key]: !isOpen }))
                    }}
                    onDiscuss={() => discussReport(r)}
                    onReceipt={() => openReportReceipt(r)}
                    onOpenBoard={() => openReportBoard(r)}
                    onCopyCode={copyCode}
                  />
                )
              }
              return (
                <div key={r.key} className="msg report" title={fmtDateTime(r.at)}>
                  <span className="report-body">🖊 {r.text}</span>
                  <button
                    type="button"
                    className="report-link"
                    onClick={() => {
                      haptic('tap')
                      window.dispatchEvent(
                        new CustomEvent(HM_EVENTS.OPEN_REVIEW, {
                          detail: { taskId: r.taskId, label: r.label },
                        }),
                      )
                    }}
                  >
                    {t('chat.reviewAndAnnotate')}
                  </button>
                </div>
              )
            }
            const b = item.block
            const i = item.index
            // 配列添字だと履歴を先頭に足したとき開閉状態（expandedTools）がズレる。
            // mid が無いブロックは実体ごとに採番した key を使い、衝突（= 幽霊 DOM）を防ぐ。
            let blockKey = b.mid != null && b.mid !== '' ? `mid-${b.mid}` : blockKeysRef.current.get(b)
            if (!blockKey) {
              blockKeySeqRef.current += 1
              blockKey = `at-${b.at || i}-${blockKeySeqRef.current}`
              blockKeysRef.current.set(b, blockKey)
            }
            return b.role === 'user' ? (
              <div
                key={blockKey}
                data-mid={b.mid}
                className={`msg user${readonly?.focusId && b.mid === readonly.focusId ? ' hit' : ''}`}
              >
                <div className="bubble">
                  {b.images?.length ? (
                    <div className="bubble-imgs">
                      {b.images.map((img, k) =>
                        img.url ? (
                          <span className="bubble-img" key={k}>
                            <img src={img.url} alt={img.name ?? t('chat.attachedImage')} />
                          </span>
                        ) : null,
                      )}
                    </div>
                  ) : null}
                  {b.files?.length ? (
                    <div className="bubble-files">
                      {b.files.map((f, k) => (
                        <span className="file-chip" key={k}>
                          📎 {f.name}
                          {f.bytes ? <span className="file-size">{fmtBytes(f.bytes)}</span> : null}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {b.text}
                  {b.text ? (
                    <button
                      type="button"
                      className="bubble-menu-btn"
                      aria-label={t('chat.bubbleMenuAria')}
                      onClick={(e) => {
                        e.stopPropagation()
                        haptic('tap')
                        onOpenBubbleMenu({ text: b.text, role: 'user', mid: b.mid ?? null })
                      }}
                    >
                      <Icon name="more" size={14} />
                    </button>
                  ) : null}
                </div>
              </div>
            ) : b.role === 'assistant' ? (
              <div
                key={blockKey}
                data-mid={b.mid}
                className={`msg bot${readonly?.focusId && b.mid === readonly.focusId ? ' hit' : ''}`}
              >
                <div className={`bubble${justSettled && itemIdx === timeline.length - 1 ? ' vibe-settle-flash' : ''}`}>
                  {b.tools?.length ? (
                    <details className="msg-tools">
                      <summary>{t('chat.toolsRan', { count: b.tools.length })}</summary>
                      <ToolRows
                        rows={b.tools}
                        prefix={blockKey}
                        expandedMap={expandedTools}
                        onToggle={toggleToolExpand}
                      />
                    </details>
                  ) : null}
                  {b.text ? (
                    <>
                      <MarkdownBody text={b.text} onCopyCode={copyCode} copyLabel={t('chat.copy')} />
                      <button
                        type="button"
                        className="bubble-menu-btn"
                        aria-label={t('chat.bubbleMenuAria')}
                        onClick={(e) => {
                          e.stopPropagation()
                          haptic('tap')
                          onOpenBubbleMenu({ text: b.text, role: 'assistant', mid: b.mid ?? null })
                        }}
                      >
                        <Icon name="more" size={14} />
                      </button>
                    </>
                  ) : b.open ? (
                    <span className="dots">…</span>
                  ) : (
                    ''
                  )}
                </div>
              </div>
            ) : (
              <div key={blockKey} className="msg notice">
                {b.text}
              </div>
            )
          })}
          {isWorking ? (() => {
            const started = runStartedAt || activeLiveTurn?.startedAt
            const sec = started ? Math.max(0, Math.floor((nowTick - started) / 1000)) : 0
            const mm = String(Math.floor(sec / 60)).padStart(2, '0')
            const ss = String(sec % 60).padStart(2, '0')
            const liveFallbackRows =
              !progress.length && activeLiveTurn?.lastTool?.name
                ? [{ id: 'live-last', name: activeLiveTurn.lastTool.name, detail: activeLiveTurn.lastActivity || '', full: activeLiveTurn.lastActivity || '', done: false }]
                : []
            const rowsToShow = progress.length ? progress : liveFallbackRows
            const thinkingLines = thinking ? thinking.trim().split('\n') : []
            const thinkingShown = thinkingExpanded ? thinking.trim() : thinkingLines.slice(-3).join('\n')
            return (
              <div className="thinking thinking-card" data-heat={sec >= 30 ? 'high' : 'normal'} role="status">
                <div className="working-head">
                  <span className="working-dot" aria-hidden="true" />
                  <b className="working-shimmer">Working… {mm}:{ss}</b>
                  <span className="working-meta">
                    {progress.length
                      ? t('chat.toolProgress', { n: progress.length })
                      : activeLiveTurn?.lastTool?.name
                        ? t('chat.lastTool', { name: activeLiveTurn.lastTool.name })
                        : t('chat.thinking')}
                  </span>
                </div>
                {rowsToShow.length ? (
                  <ToolRows
                    rows={rowsToShow}
                    prefix="live"
                    expandedMap={expandedTools}
                    onToggle={toggleToolExpand}
                  />
                ) : null}
                {thinkingShown ? (
                  <div
                    className={`thinking-text${thinkingExpanded ? ' expanded' : ''}`}
                    onClick={() => setThinkingExpanded((v) => !v)}
                  >
                    {thinkingShown}
                  </div>
                ) : null}
              </div>
            )
          })() : null}
          {linkedReview ? (
            isWaiting(linkedReview) ? (
              <div className="chat-live-card warn" role="status">
                <div className="chat-live-head">
                  <span className="chat-live-title">
                    {t('chat.reviewLabel', { title: linkedReview.review?.title || linkedReview.title })}
                  </span>
                  <button
                    type="button"
                    className="chat-report-btn primary"
                    onClick={() => {
                      haptic('tap')
                      window.dispatchEvent(
                        new CustomEvent(HM_EVENTS.OPEN_REVIEW, {
                          detail: { taskId: linkedReview.id, label: linkedReview.review?.label },
                        }),
                      )
                    }}
                  >
                    {t('chat.openInReview')}
                  </button>
                </div>
                <div className="chat-live-sub">
                  {t('chat.linkedWaiting')}
                </div>
              </div>
            ) : (
              <div className="chat-live-card running" data-heat={linkedReview.status === 'running' ? 'high' : 'normal'} role="status">
                <div className="chat-live-head">
                  <span className="working-dot" aria-hidden="true" />
                  <b className="working-shimmer">
                    {linkedReview.status === 'running' ? t('chat.workerRunning') : t('chat.workerQueued')}
                  </b>
                  <button
                    type="button"
                    className="chat-report-btn"
                    onClick={() => {
                      haptic('tap')
                      window.dispatchEvent(
                        new CustomEvent(HM_EVENTS.OPEN_REVIEW, {
                          detail: { taskId: linkedReview.id, label: linkedReview.review?.label },
                        }),
                      )
                    }}
                  >
                    {t('chat.watchProgress')}
                  </button>
                </div>
                <div className="chat-live-sub">{linkedReview.review?.title || linkedReview.title}</div>
                {(() => {
                  const steps = (workerFeed?.feed?.messages || [])
                    .filter((m) => m.role !== 'user')
                    .slice(-4)
                  if (!steps.length) return null
                  return (
                    <ToolRows
                      rows={steps.map((m, idx) => {
                        const raw = String(m.text || '').replace(/\s+/g, ' ').trim()
                        return {
                          id: String(m.id ?? idx),
                          name: m.role === 'tool' ? m.toolName || 'tool' : 'agent',
                          detail: shortenPath(raw, 56),
                          full: raw.slice(0, 300),
                          done: idx < steps.length - 1,
                        }
                      })}
                      prefix={`worker-${linkedReview.id}`}
                      expandedMap={expandedTools}
                      onToggle={toggleToolExpand}
                    />
                  )
                })()}
              </div>
            )
          ) : null}
          {usage ? (
            <div className="usage">
              in {usage.input ?? 0} / out {usage.output ?? 0}
              {usage.cache_read ? ` / cache ${usage.cache_read}` : ''}
            </div>
          ) : null}
        </div>

        {!atBottom && timeline.length > 0 ? (
          <button
            type="button"
            className={`chat-jump-bottom${isWorking || linkedReview ? ' active' : ''}`}
            onClick={() => {
              haptic('tap')
              if (scrollMessagesToEnd(listRef)) {
                stickRef.current = true
                setAtBottom(true)
              }
            }}
          >
            {isWorking || linkedReview ? t('chat.jumpLatest') : t('chat.jumpBottomPlain')}
          </button>
        ) : null}
      </div>
    </>
  )
}
