import React, { useRef, useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { HoldButton, Icon, Loader, RefreshButton, Sheet, relTime } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { CaptureSheet } from './CaptureSheet.jsx'
import { UsageSheet } from './UsageSheet.jsx'
import { MissionReceiptSheet } from './MissionReceiptSheet.jsx'
import { SpecSeedSheet } from './SpecSeedSheet.jsx'
import { BrainstormSheet, RefactorSheet } from './TaskToolSheets.jsx'
import { SpecReadyBanner } from '../components/SpecReadyBanner.jsx'
import { SpecRunningBar } from '../components/SpecRunningBar.jsx'
import { CoherenceBanner } from '../components/CoherenceBanner.jsx'
import { SpecMarkdownSheet } from '../components/SpecMarkdownSheet.jsx'
import { ArchitectJobBar } from '../components/ArchitectJobBar.jsx'
import { LiveSheet } from './LiveSheet.jsx'
import { InboxSheet } from './InboxSheet.jsx'
import { BoardPickerSheet } from './tasks/BoardPickerSheet.jsx'
import { AutopilotSwipeLink } from './autopilot/AutopilotView.jsx'
import { fmtCost, sep } from '../lib/format.js'
import { readActiveChatId, reportSummaryLine, toEpochMs } from '../lib/chatReports.js'
import { renderMarkdown } from '../lib/markdown.js'
import { useI18n } from '../i18n/index.js'
import { useSplitLayout } from '../lib/useSplitLayout.js'
import {
  archivedTaskCount,
  archivableTasks,
  bulkArchivePayload,
  isArchivedTask,
  organizeRowView,
  selectableBrokenTasks,
  visibleTasks,
} from '../lib/tasksView.js'
import { HM_EVENTS, emitHmEvent } from '../contracts/events.js'
import { ModePill, SpecPicker } from './tasks/SpecPicker.jsx'
import { STATUS_KEY, TaskDetailSheet } from './tasks/TaskDetailSheet.jsx'
import { useTasksData } from './tasks/useTasksData.js'
import { useSpecLaunchpad } from './tasks/useSpecLaunchpad.js'


/**
 * タスクタブ（ホーム）。SystemOps の状態 + カンバン + キルスイッチ。
 *
 * 取得・反映・ポーリング・memo と Gateway 操作は `tasks/useTasksData.js`、
 * SPEC の選択・起票・履歴は `tasks/useSpecLaunchpad.js` が持つ。
 * この pane は描画と、シートの開閉だけを持つ（CSW3-6 / CSW3-7 で切り分ける）。
 */
export function TasksPane({ overview, refresh, notify, initialInbox = null, pendingInboxOpen = null, onConsumedPendingInboxOpen, focusBoard = null, onConsumedFocusBoard, taskToolRequest = null, onConsumedTaskTool, active = true }) {
  const { t } = useI18n()

  const data = useTasksData({ notify, refresh, active, initialInbox, pendingInboxOpen, onConsumedPendingInboxOpen })
  const {
    boards, board, setBoard, tasks, loading, latestReport, usageData, liveTurns, inboxCount,
    specsInfo, specPath, setSpecPath, architectFiling, architectDismissed, setArchitectDismissed,
    architectJobClosed, setArchitectJobClosed, archivedTaskTotal,
    inboxOpen, inboxFocus, openInbox, closeInbox, loadInbox,
    loadBoards, loadTasks, loadSpecs, loadArchitectJobs, refreshAll,
    activeJob, architectRunning, specBanner, idle, reportRecent, coherenceView,
    latestReportBody,
    fileSpecBatches, dismissCoherence, discussLatestReport,
    busy, killOpen, setKillOpen, setConfirmText, gatewayAction, stopAllAction, pauseAction, resumeAction,
  } = data

  const launchpad = useSpecLaunchpad({
    board,
    tasks,
    specsInfo,
    specPath,
    setSpecPath,
    loadSpecs,
    loadArchitectJobs,
    loadTasks,
    notify,
  })
  const {
    currentSpec, specList, specArchivedCount, activeSpecRun, specProg, filedBatchIds,
    openBatchIds, specAllDone, historySpecList, historySpec, historyProg,
    specSheetOpen, setSpecSheetOpen, specSel, setSpecSel, specBusy, specPickerOpen,
    setSpecPickerOpen, specBatchOpen, setSpecBatchOpen, specShowArchived, setSpecShowArchived,
    specHistoryOpen, setSpecHistoryOpen, historyShowArchived, setHistoryShowArchived,
    setHistorySpecPath, specMd, setSpecMd,
    openSpecSheet, openSpecHistory, pickSpec, archiveCurrentSpec, archiveBannerSpec, openSpecMd,
    launchBatches,
  } = launchpad

  const [detailTarget, setDetailTarget] = useState(null)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [boardSheetOpen, setBoardSheetOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [receiptCtx, setReceiptCtx] = useState(null)
  const [liveOpen, setLiveOpen] = useState(false)
  const [seedOpen, setSeedOpen] = useState(false)
  const [seedInitial, setSeedInitial] = useState('')
  const [brainstormOpen, setBrainstormOpen] = useState(false)
  const [brainstormInitial, setBrainstormInitial] = useState('')
  const [refactorOpen, setRefactorOpen] = useState(false)
  // バナーから開くときのスイープ（`RefactorSheet` の `initialPreset`・SPEC-COHERENCE §3.6）
  const [refactorPreset, setRefactorPreset] = useState('')
  const [coherenceOpen, setCoherenceOpen] = useState(false)
  const [showArchivedTasks, setShowArchivedTasks] = useState(false)
  const [organize, setOrganize] = useState(false)
  const [organizeSel, setOrganizeSel] = useState([])
  const [organizeBusy, setOrganizeBusy] = useState(false)

  useEffect(() => {
    if (!taskToolRequest) return
    if (taskToolRequest.kind === 'brainstorm') {
      setBrainstormInitial(taskToolRequest.seed || '')
      setBrainstormOpen(true)
    } else if (taskToolRequest.kind === 'seed') {
      setSeedInitial(taskToolRequest.seed || '')
      setSeedOpen(true)
    }
    onConsumedTaskTool?.()
  }, [taskToolRequest, onConsumedTaskTool])

  // 同じタスクを開き直したことを TaskDetailSheet に伝える世代番号
  const detailSeq = useRef(0)

  /** 整理モードの一括アーカイブ（SPEC-RELIABILITY-GUARD RG-3 / D92）。 */
  const bulkArchiveSelected = async () => {
    if (!board) return
    const ids = bulkArchivePayload(organizeSel, tasks)
    if (!ids.length) {
      notify(t('tasks.organizeNone'))
      return
    }
    setOrganizeBusy(true)
    try {
      const r = await api(`/api/boards/${encodeURIComponent(board)}/tasks/bulk-archive`, {
        method: 'POST',
        // 理由はカンバンのコメントに残るので UI 言語で書く（英語 UI に日本語を残さない）
        body: { taskIds: ids, reason: t('tasks.organizeReason'), by: 'mobile' },
      })
      const archived = Array.isArray(r?.archived) ? r.archived.length : 0
      const skippedRunning = Array.isArray(r?.skippedRunning) ? r.skippedRunning.length : 0
      notify(t('tasks.organizeArchived', { n: archived, running: skippedRunning }))
      setOrganizeSel([])
      emitHmEvent(HM_EVENTS.WAKE_SYNC)
      await loadTasks(board)
    } catch (e) {
      notify(e.message)
    } finally {
      setOrganizeBusy(false)
    }
  }

  /* ChatPane からの「📋 ボードを見る」および `taskId` 付き詳細オープン（D43）。 */
  useEffect(() => {
    if (!focusBoard?.board) return
    // ボード一覧の取得前に消費すると選択が空振りする（実測: チップが既定のまま残った）
    if (!boards.length) return
    if (boards.some((b) => b.slug === focusBoard.board)) setBoard(focusBoard.board)
    const taskId = String(focusBoard.taskId ?? '').trim()
    if (taskId) openTask({ id: taskId, title: '' }, focusBoard.board)
    onConsumedFocusBoard?.()
    // openTask は毎レンダー作り直される素の関数。focusBoard が変わった時だけ開けば足りる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBoard, boards, onConsumedFocusBoard])

  /** タスク詳細を開く（`boardSlug` は別ボードのジョブから開くときの固定用・D43）。 */
  const openTask = (task, boardSlug = board) => {
    detailSeq.current += 1
    setDetailTarget({
      id: String(task.id),
      board: String(boardSlug ?? board ?? '').trim(),
      title: task.title ?? '',
      // 同じ id をタップし直したときだけ取得し直すための世代番号
      seq: detailSeq.current,
    })
  }

  /* Architect ジョブの「🔍 進捗詳細」（SPEC-PILOT-V9 §3.3 ② / D43 後半）。 */
  const inspectArchitectJob = (job) => {
    const taskId = String(job?.taskId ?? '').trim()
    const targetBoard = String(job?.board ?? board ?? '').trim()
    if (!taskId || !targetBoard) {
      setLiveOpen(true)
      return
    }
    haptic('tap')
    if (targetBoard !== board && boards.some((b) => b.slug === targetBoard)) setBoard(targetBoard)
    const title = String(job?.seed ?? '').trim()
    openTask({ id: taskId, title: title ? title.slice(0, 40) : taskId }, targetBoard)
  }

  const bridge = overview?.bridge
  const mem = overview?.system?.memory
  const disk = overview?.system?.disk
  const running = tasks.filter((task) => task.status === 'running').length
  // タスク一覧の表示（D92）: 既定はアーカイブを隠し、N はサーバの件数を優先する。
  const archivedShown = archivedTaskCount(tasks, archivedTaskTotal)
  const shownTasks = visibleTasks(tasks, showArchivedTasks)
  const organizeTargets = archivableTasks(tasks)
  const brokenSelection = selectableBrokenTasks(tasks)
  const paused = overview?.paused ?? { engaged: false }
  // >=680px は 2 ペイン（詳細をシートではなく右ペインに出す。SPEC-i18n-resp §2 B3）
  // 境界は lib/layout.js の 1 箇所だけ（CSS の @media と一致させる）
  const { split } = useSplitLayout()

  /** ボード 1 行の補足（実行中・停止・保管・最終更新）。 */
  const boardMeta = (b) =>
    [
      b?.counts?.running ? t('tasks.boardRunning', { n: b.counts.running }) : null,
      b?.counts?.blocked ? t('tasks.boardBlocked', { n: b.counts.blocked }) : null,
      b?.archived ? t('tasks.boardArchived') : null,
      b?.lastActivityAt ? relTime(b.lastActivityAt * 1000) : null,
    ]
      .filter(Boolean)
      .join(' · ')
  const currentBoard = boards.find((b) => b.slug === board) ?? null

  /** バナーの 1 タップ起動: 推奨スイープを選択済みにして `RefactorSheet` を開く。 */
  const openCoherenceSweep = useCallback(() => {
    haptic('tap')
    setRefactorPreset(coherenceView.recommendedSweep || '')
    setRefactorOpen(true)
  }, [coherenceView.recommendedSweep])

  /**
   * 完了レシート（🏆）を開く。既定は「いま見ているボード ＋ 表示中の Spec」。
   * 完走レポートがあればそちらの board / spec を優先する（別ボードの完走でも正しい対象になる）。
   */
  const openReceipt = (report = null) => {
    haptic('tap')
    setReceiptCtx({
      board: report?.board ?? board ?? null,
      spec: report?.spec ?? currentSpec?.path ?? null,
    })
  }

  const closeDetail = () => {
    setDetailTarget(null)
    setConfirmText('')
  }
  return (
    <div className={split ? 'pane split-layout tasks' : 'pane'}>
      <div className={split ? 'split-master' : undefined}>
      {paused.engaged ? (
        <div className="banner paused">
          {t('tasks.pausedBanner', { reason: paused.reason ? ` ${sep()} ${paused.reason}` : '' })}
          <button onClick={resumeAction} disabled={busy}>
            {t('tasks.resume')}
          </button>
        </div>
      ) : null}

      {inboxCount ? (
        <button className="inbox-bar" onClick={() => openInbox(null)}>
          <span>{t('tasks.inboxBar', { n: inboxCount })}</span>
          <span className="inbox-bar-go">{t('tasks.inboxBarGo')}</span>
        </button>
      ) : null}

      {/* Architect の進行バー（SPEC V6 §3.3 ②）: Seed のあと「今どこか」を画面上部に残す */}
      <ArchitectJobBar
        job={activeJob}
        board={board ?? ''}
        repo={specsInfo?.repo ?? null}
        chat={readActiveChatId(globalThis.localStorage) || null}
        onInspect={inspectArchitectJob}
        onRetried={async () => {
          await Promise.all([loadArchitectJobs(), loadSpecs(board)])
        }}
        onDismiss={(jobId) => setArchitectJobClosed((prev) => [...prev, jobId])}
        notify={notify}
      />

      {/* A2B クイック起票カード（SPEC V5 §3.2 D23）: 仕様書ができた瞬間に 1 タップ起票 */}
      <SpecReadyBanner
        banner={specBanner}
        busy={architectFiling}
        onFile={fileSpecBatches}
        onDismiss={(b) => setArchitectDismissed((prev) => [...prev, b.path])}
        onPreview={(b) => openSpecMd({ path: b.path, title: b.title })}
        onArchive={archiveBannerSpec}
      />

      {/* バッチ一括起票後の自走実行サマリ（問題③）: 稼働中の SPEC 進捗と詳細への導線 */}
      <SpecRunningBar
        summary={activeSpecRun}
        onInspect={(task) => openTask(task, board)}
        onOpenBatches={(spec) => {
          pickSpec(spec, true)
          setSpecSheetOpen(true)
        }}
      />

      {/*
        完走予兆の提案バナー（SPEC-COHERENCE §3.6 / D83 / 問題④）。
        作業中は表示と 120s 診断を控え、作業完了後に残る問題だけ 1 タップスイープで示す。
      */}
      <CoherenceBanner
        view={coherenceView}
        open={coherenceOpen}
        onToggle={() => setCoherenceOpen((v) => !v)}
        onOpenSweep={openCoherenceSweep}
        onDismiss={dismissCoherence}
      />

      {/* 📝 Spec Seed ＋ 🧠 ブレスト ＋ 🛠 リファクタリング（同列エントリ） */}
      <div className="seed-entry">
        <button
          type="button"
          className="snippet-chip trigger"
          onClick={() => {
            haptic('tap')
            setSeedInitial('')
            setSeedOpen(true)
          }}
          aria-label={t('seed.openAria')}
        >
          📝 {t('seed.title')}
        </button>
        <button
          type="button"
          className="snippet-chip trigger"
          onClick={() => {
            haptic('tap')
            setBrainstormInitial('')
            setBrainstormOpen(true)
          }}
        >
          🧠 {t('brainstorm.title')}
        </button>
        <button
          type="button"
          className="snippet-chip trigger"
          onClick={() => {
            haptic('tap')
            setRefactorPreset('')
            setRefactorOpen(true)
          }}
        >
          🛠 {t('refactor.title')}
        </button>
      </div>

      {/* Spec Launchpad（SPEC §5.4）: ボードのリポジトリに SPEC があれば常設のバー。
          全バッチ完了後は「✅ 全バッチ完了」カードになり、タップで履歴（縦リスト）を開く（Q3=A） */}
      {currentSpec ? (
        <button
          className={`spec-bar${specAllDone ? ' is-done' : ''}`}
          onClick={specAllDone ? openSpecHistory : openSpecSheet}
          aria-label={t(specAllDone ? 'tasks.specHistoryAria' : 'tasks.specBarAria', { name: currentSpec.title })}
        >
          <span className="spec-bar-main">
            <span className="spec-bar-title">
              {specAllDone ? `✅ ${t('tasks.specAllDone')}` : `🚀 ${t('tasks.specLaunchpad')}`}
            </span>
            <span className="spec-bar-name">{currentSpec.title}</span>
          </span>
          <span className="spec-bar-n">
            {t('tasks.specBatchCount', { n: currentSpec.batches.length })}
            <Icon name="chevron" size={14} />
          </span>
        </button>
      ) : null}

      {/* 直近のパイプライン完走サマリ（SPEC-PILOT-V4 §3.3 ③ / D20③）。 */}
      {latestReport && (idle || reportRecent) ? (
        <details className={`pipeline-summary-card${String(latestReport.status ?? '') === 'halted' ? ' is-halted' : ''}`}>
          <summary className="pipeline-summary-head">
            <span className="pipeline-summary-icon" aria-hidden="true">
              {String(latestReport.status ?? '') === 'halted' ? '⚠️' : '🎉'}
            </span>
            <span className="pipeline-summary-title">{latestReport.label || t('tasks.pipelineSummary')}</span>
            <span className="pipeline-summary-sub">{reportSummaryLine(latestReport, 48)}</span>
            <span className="pipeline-summary-when">{relTime(toEpochMs(latestReport.at) || 0)}</span>
          </summary>
          <div className="pipeline-summary-body">
            {latestReportBody}
            <div className="pipeline-summary-actions">
              <button type="button" className="report-card-btn primary" onClick={discussLatestReport}>
                {t('tasks.discussReport')}
              </button>
              <button type="button" className="report-card-btn" onClick={() => openReceipt(latestReport)}>
                {t('receipt.open')}
              </button>
              {/* ここは「折りたたむ」。カードごと消すとタスクタブから報告が消える（実機） */}
              <button
                type="button"
                className="report-card-btn"
                onClick={(e) => {
                  const d = e.currentTarget.closest('details')
                  if (d) d.open = false
                }}
              >
                {t('tasks.pipelineCollapse')}
              </button>
            </div>
          </div>
        </details>
      ) : null}

      <div className="strip">
        <div className={`stat ${bridge?.ok === false ? 'bad' : bridge ? 'good' : ''}`}>
          <span className="stat-k">{t('tasks.bridge')}</span>
          <span className="stat-v">{bridge ? (bridge.ok ? t('tasks.ok') : t('tasks.disconnected')) : '—'}</span>
        </div>
        <button className="stat" onClick={() => setUsageOpen(true)} aria-label={t('tasks.usageAria')}>
          <span className="stat-k">24h</span>
          <span className="stat-v">{usageData?.ok ? fmtCost(usageData.totals.cost) : '—'}</span>
        </button>
        <div className="stat">
          <span className="stat-k">{t('tasks.memory')}</span>
          <span className="stat-v">{mem ? `${mem.percent}%` : '—'}</span>
        </div>
        <div className="stat">
          <span className="stat-k">{t('tasks.disk')}</span>
          <span className="stat-v">{disk ? `${disk.percent}%` : '—'}</span>
        </div>
        <button
          className={`stat ${running || architectRunning ? 'warn' : ''}`}
          onClick={() => setLiveOpen(true)}
          aria-label={t('tasks.liveAria')}
        >
          <span className="stat-k">
            {t('tasks.runningLabel')}
            {liveTurns || architectRunning ? (
              <i
                className="live-dot"
                title={t('tasks.turnTitle', { n: liveTurns + architectRunning })}
              />
            ) : null}
          </span>
          {/* Architect（仕様策定）の稼働分も「実行中」に数える（D43 後半）。 */}
          <span className="stat-v">{running + liveTurns + architectRunning}</span>
        </button>
      </div>

      {/*
        ボード切替（Q1=B / Q2=A）: 増えうる一覧は縦リストに統一し、横スクロールは使わない。
        常設は「いま選んでいるボード」1 行（.pick-item.on）。全件はこの行をタップして
        縦リストのシートで選ぶ（▾ の意味は変えない）。
      */}
      <button
        className="pick-item board-now"
        onClick={() => setBoardSheetOpen(true)}
        aria-label={t('tasks.boardOpenAria')}
        title={t('tasks.boardList')}
      >
        <span className="pick-main">
          <span className="pick-title">
            <span aria-hidden="true">{currentBoard?.icon ?? '🗂'}</span> {currentBoard?.name ?? board ?? t('tasks.board')}
          </span>
          <span className="pick-sub">{boardMeta(currentBoard)}</span>
        </span>
        <span className="pick-meta">
          {t('tasks.boardCount', { n: boards.length })}
          <Icon name="chevron" size={14} />
        </span>
      </button>

      {boardSheetOpen && (
        <BoardPickerSheet
          boards={boards}
          board={board}
          boardMeta={boardMeta}
          onSelect={setBoard}
          onRefreshBoards={() => loadBoards({ silent: true })}
          onClose={() => setBoardSheetOpen(false)}
          notify={notify}
        />
      )}

      {seedOpen ? (
        <SpecSeedSheet
          board={board ?? ''}
          repo={specsInfo?.repo ?? null}
          chat={readActiveChatId(globalThis.localStorage) || null}
          initialText={seedInitial}
          notify={notify}
          onClose={() => {
            setSeedOpen(false)
            setSeedInitial('')
          }}
          onSeeded={() => loadArchitectJobs()}
        />
      ) : null}

      {brainstormOpen ? (
        <BrainstormSheet
          initialSeed={brainstormInitial}
          board={board ?? ''}
          repo={specsInfo?.repo ?? null}
          notify={notify}
          onClose={() => {
            setBrainstormOpen(false)
            setBrainstormInitial('')
          }}
        />
      ) : null}

      {refactorOpen ? (
        <RefactorSheet
          board={board ?? ''}
          repo={specsInfo?.repo ?? null}
          initialPreset={refactorPreset}
          notify={notify}
          onClose={() => {
            setRefactorOpen(false)
            setRefactorPreset('')
          }}
        />
      ) : null}

      {specSheetOpen && currentSpec ? (
        <Sheet title={t('tasks.specSheetTitle')} onClose={() => !specBusy && setSpecSheetOpen(false)}>
          {/* 上部は親スコープ枠（選択中 SPEC ＋ プレビュー操作）として子のバッチ一覧と階層を分ける */}
          <div className={`spec-context-box${specPickerOpen ? ' is-open' : ''}`}>
            <SpecPicker
              specList={specList}
              currentSpec={currentSpec}
              open={specPickerOpen}
              onToggle={() => setSpecPickerOpen((v) => !v)}
              onPick={(s) => pickSpec(s, true)}
              archivedCount={specArchivedCount}
              showArchived={specShowArchived}
              onToggleArchived={setSpecShowArchived}
              t={t}
            />
            <div className="spec-md-row">
              <button type="button" className="btn spec-md-open" onClick={() => openSpecMd(currentSpec)}>
                {`📄 ${t('tasks.specMdPreview')}`}
              </button>
            </div>
          </div>
          <div className="spec-children-section">
            <div className="list-head spec-children-head">
              {t('tasks.specBatchesHead', { n: currentSpec.batches.length })}
            </div>
            <div className="list">
            {currentSpec.batches.map((b) => {
              const filed = filedBatchIds.has(b.id)
              const taken = openBatchIds.has(b.id)
              const bt = specProg.byId.get(b.id)
              const badgeKey = taken
                ? 'tasks.specAlready'
                : bt?.status === 'archived'
                  ? 'tasks.status.archived'
                  : 'tasks.specFiledDone'
              const sel = specSel.includes(b.id)
              const open = specBatchOpen.includes(b.id)
              return (
                /* 行の本体＝チェックボックス選択（1 タップ）／下の「仕様・Verify ▾」は独立（D29） */
                <div className={`spec-batch${sel ? ' on' : ''}`} key={b.id}>
                  <button
                    type="button"
                    className={`list-item${sel ? ' on' : ''}`}
                    onClick={() => {
                      haptic('tap')
                      setSpecSel((cur) => (cur.includes(b.id) ? cur.filter((x) => x !== b.id) : [...cur, b.id]))
                    }}
                  >
                    <span className="spec-check" aria-hidden="true">
                      {sel ? '☑' : '☐'}
                    </span>
                    <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                      <span className="row-title">
                        [{b.id}] {b.title}
                      </span>
                      <ModePill batch={b} t={t} />
                      {b.objective ? <span className="row-sub">{b.objective.slice(0, 140)}</span> : null}
                    </span>
                    {filed ? (
                      <span className="spec-taken">
                        {t(badgeKey)}
                        {bt?.id ? ` · ${bt.id}` : ''}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="link spec-batch-toggle"
                    aria-expanded={open}
                    onClick={() => {
                      haptic('tap')
                      setSpecBatchOpen((cur) => (cur.includes(b.id) ? cur.filter((x) => x !== b.id) : [...cur, b.id]))
                    }}
                  >
                    {t('tasks.specDetailToggle')} {open ? '▴' : '▾'}
                  </button>
                  {open ? (
                    <div className="spec-batch-detail">{renderMarkdown(b.section || b.title || '')}</div>
                  ) : null}
                </div>
              )
            })}
          </div>
          {/* 起票するものがあるときは起票、全部完了しているときは履歴へ（ボタンは行き先を名乗る） */}
          {specAllDone ? (
            <button
              className="btn"
              style={{ marginTop: 12, width: '100%' }}
              onClick={() => {
                setSpecSheetOpen(false)
                openSpecHistory()
              }}
            >
              {t('tasks.specHistoryTitle')}
            </button>
          ) : (
            <button
              className="btn primary"
              style={{ marginTop: 12, width: '100%' }}
              disabled={specBusy || !specSel.length}
              onClick={launchBatches}
            >
              {specBusy ? t('tasks.specLaunching') : t('tasks.specLaunchBtn', { n: specSel.length })}
            </button>
          )}
          <div className="row-sub" style={{ padding: '8px 4px', lineHeight: 1.6 }}>
            {t('tasks.specNote')}
          </div>
          </div>
        </Sheet>
      ) : null}

      {/* 全バッチ完了後の履歴（Q3=A）。行＝バッチ＋完了バッジ＋完了時刻。増えうる一覧なので縦リスト */}
      {specHistoryOpen && historySpec ? (
        <Sheet title={t('tasks.specHistoryTitle')} onClose={() => setSpecHistoryOpen(false)}>
          {/* 上部は親スコープ枠（SPEC 選択 ＋ プレビュー操作）として子のバッチ履歴と階層を分ける */}
          <div className={`spec-context-box${specPickerOpen ? ' is-open' : ''}`}>
            <SpecPicker
              specList={historySpecList}
              currentSpec={historySpec}
              open={specPickerOpen}
              onToggle={() => setSpecPickerOpen((v) => !v)}
              onPick={(s) => {
                setHistorySpecPath(s.path)
                setSpecPickerOpen(false)
              }}
              archivedCount={specArchivedCount}
              showArchived={historyShowArchived}
              onToggleArchived={setHistoryShowArchived}
              t={t}
            />
            <div className="spec-md-row">
              <button type="button" className="btn spec-md-open" onClick={() => openSpecMd(historySpec)}>
                {`📄 ${t('tasks.specMdPreview')}`}
              </button>
            </div>
          </div>
          <div className="spec-children-section">
            <div className="list-head spec-children-head">
              {t('tasks.specBatchesHead', { n: historySpec.batches.length })}
            </div>
            {/* 1 行 1 バッチ。タップで展開して目的・結果・Git・抜粋まで読む（§3.5 ② / D29） */}
            <div className="pick-list">
            {historySpec.batches.map((b) => {
              const task = historyProg.byId.get(b.id) ?? null
              const done = task?.status === 'done'
              const stateText = task
                ? STATUS_KEY[task.status]
                  ? t(STATUS_KEY[task.status])
                  : task.status
                : t('tasks.specNotFiled')
              const when = done
                ? task?.completedAt
                  ? relTime(task.completedAt)
                  : null
                : task?.startedAt
                  ? t('tasks.specStartedAt', { when: relTime(task.startedAt) })
                  : null
              return (
                <details key={b.id} className="pick-item history-row">
                  <summary className="history-summary">
                    <span className={`dot ${task?.status ?? 'todo'}`} />
                    <span className="history-title" title={`[${b.id}] ${b.title}`}>
                      [{b.id}] {b.title}
                    </span>
                    <span className="history-state">{done ? t('tasks.specDoneBadge') : stateText}</span>
                    <Icon name="chevron" size={14} />
                  </summary>
                  <div className="history-body">
                    <div className="history-head">
                      <ModePill batch={b} t={t} />
                      <span className="history-state-in">{stateText}</span>
                      {task ? <span className="history-task">{t('tasks.specTaskId', { id: task.id })}</span> : null}
                      {when ? <span className="history-when">{when}</span> : null}
                    </div>
                    {b.objective ? (
                      <>
                        <div className="history-label">{t('tasks.specObjective')}</div>
                        <div className="history-objective">{b.objective}</div>
                      </>
                    ) : null}
                    {task?.result ? (
                      <>
                        <div className="history-label">{t('tasks.specResult')}</div>
                        <div className="history-result">{task.result}</div>
                      </>
                    ) : null}
                    {task?.git?.head ? (
                      <div className="git-badge">
                        <span className="git-sha">{task.git.head}</span>
                        {task.git.subject ? <span className="git-subject">{task.git.subject}</span> : null}
                      </div>
                    ) : null}
                    {task ? (
                      <button
                        type="button"
                        className="btn history-open-task"
                        onClick={() => {
                          haptic('action')
                          setSpecHistoryOpen(false)
                          openTask(task)
                        }}
                      >
                        {`🔍 ${t('tasks.specOpenTask')}`}
                      </button>
                    ) : null}
                    <details className="history-sub-details">
                      <summary>{t('tasks.specSection')}</summary>
                      <div className="history-section">{renderMarkdown(b.section || b.title || '')}</div>
                    </details>
                  </div>
                </details>
              )
            })}
          </div>
          {/* 全バッチ完了後・アーカイブ済みは起票導線を出さない（意味の無いボタンを残さない） */}
          {historySpec.archived || historyProg.allDone ? null : (
            <button
              className="btn"
              style={{ marginTop: 12, width: '100%' }}
              onClick={() => {
                setSpecHistoryOpen(false)
                pickSpec(historySpec, true)
                setSpecPickerOpen(false)
                setSpecSheetOpen(true)
              }}
            >
              {t('tasks.specOpenLaunch')}
            </button>
          )}
          {/* 不要・テスト用 SPEC の退避（D92）。ファイルは消さず、ヘッダに 1 行足すだけ */}
          {historySpec && !historySpec.archived ? (
            <div className="spec-archive-row">
              <HoldButton
                label={t('tasks.specArchiveBtn')}
                sub={t('tasks.specArchiveSub')}
                tone="danger"
                onFire={() => archiveCurrentSpec(historySpec)}
              />
            </div>
          ) : null}
          <div className="row-sub" style={{ padding: '8px 4px', lineHeight: 1.6 }}>
            {t('tasks.specHistoryNote')}
          </div>
          </div>
        </Sheet>
      ) : null}

      {/* 仕様書(MD)プレビュー（§3.4 ② / D30）。Launchpad・履歴・バナーから同じ 1 枚を開く */}
      {specMd ? (
        <SpecMarkdownSheet
          board={specMd.board ?? board}
          repo={specsInfo?.repo ?? null}
          path={specMd.path}
          title={specMd.title}
          onClose={() => setSpecMd(null)}
          onArchived={async () => {
            await Promise.all([loadSpecs(board), loadArchitectJobs()])
          }}
        />
      ) : null}

      {(overview?.counts?.reviewWaiting ?? 0) > 0 && (
        <div className="ap-swipe-strip"><AutopilotSwipeLink count={overview.counts.reviewWaiting} /></div>
      )}
      <div className="list-head">
        <span>{t('tasks.tasks')}</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="link" onClick={() => { haptic('tap'); setCaptureOpen(true) }}>{t('tasks.newTask')}</button>
          {/* 整理モードの入り口（D92）。ON の間は行がチェックボックスになる */}
          <button
            className={`link organize-toggle${organize ? ' on' : ''}`}
            aria-pressed={organize}
            onClick={() => {
              haptic('tap')
              const next = !organize
              setOrganize(next)
              if (!next) setOrganizeSel([])
            }}
          >
            {organize ? t('tasks.organizeExit') : t('tasks.organize')}
          </button>
          <RefreshButton variant="link" onRefresh={refreshAll} />
        </span>
      </div>

      {loading ? <Loader label={t('common.loading')} /> : null}
      {!loading && !tasks.length ? <div className="empty">{t('tasks.empty')}</div> : null}

      {/* 整理モードの操作帯: 失敗・停止の全選択 → 長押しで一括アーカイブ */}
      {organize ? (
        <div className="organize-bar">
          <div className="organize-head">
            <span className="organize-count">{t('tasks.organizeSelected', { n: organizeSel.length })}</span>
            <button
              type="button"
              className="link"
              disabled={!brokenSelection.length}
              onClick={() => {
                haptic('tap')
                setOrganizeSel((cur) => [...new Set([...cur, ...brokenSelection])])
              }}
            >
              {t('tasks.organizeSelectBroken', { n: brokenSelection.length })}
            </button>
            <button
              type="button"
              className="link"
              disabled={!organizeSel.length}
              onClick={() => {
                haptic('tap')
                setOrganizeSel([])
              }}
            >
              {t('tasks.organizeClear')}
            </button>
          </div>
          <div className="hold-grid">
            <HoldButton
              label={t('tasks.organizeArchive', { n: organizeSel.length })}
              sub={t('tasks.organizeHint')}
              tone="danger"
              disabled={organizeBusy || !organizeSel.length || !organizeTargets.length}
              onFire={bulkArchiveSelected}
            />
          </div>
        </div>
      ) : null}

      <div className="list">
        {shownTasks.map((task) => {
          const row = organizeRowView(task, organizeSel)
          const archived = isArchivedTask(task)
          const cls = ['row', archived ? 'is-archived' : '', row.selected ? 'on' : '', organize && !row.archivable ? 'is-locked' : '']
            .filter(Boolean)
            .join(' ')
          return (
          <button
            key={task.id}
            className={cls}
            aria-pressed={organize ? row.selected : undefined}
            onClick={() => {
              haptic('tap')
              // 整理モードでは「選択」、通常は「詳細」。実行中・アーカイブ済みは選べない
              if (organize) {
                if (!row.archivable) return
                setOrganizeSel((cur) => (cur.includes(task.id) ? cur.filter((x) => x !== task.id) : [...cur, task.id]))
                return
              }
              openTask(task)
            }}
          >
            {organize ? (
              <span className="spec-check organize-check" aria-hidden="true">
                {row.selected ? '☑' : '☐'}
              </span>
            ) : null}
            <span className={`dot ${task.status}`} />
            <span className="row-main">
              <span className="row-title">{task.title}</span>
              <span className="row-sub">
                {STATUS_KEY[task.status] ? t(STATUS_KEY[task.status]) : task.status}
                {task.status === 'running' && task.elapsedSec != null
                  ? ` ${sep()} ${t('tasks.elapsedMin', { n: Math.floor(task.elapsedSec / 60) })}`
                  : ''}
                {task.failures ? ` ${sep()} ${t('tasks.failures', { n: task.failures })}` : ''}
                {task.completedAt ? ` ${sep()} ${relTime(task.completedAt)}` : ''}
              </span>
              {task.git?.head ? (
                <span className="git-badge">
                  <span className="git-sha">{task.git.head}</span>
                  <span className="git-subject">{task.git.subject || t('tasks.noMessage')}</span>
                  {task.git.dirty ? <span className="git-dirty">{t('tasks.uncommitted')}</span> : null}
                  {task.discord ? (
                    <span
                      className="git-dc"
                      role="link"
                      tabIndex={0}
                      title={t('tasks.openInDiscord')}
                      onClick={(e) => {
                        e.stopPropagation()
                        window.open(task.discord.url, '_blank', 'noopener')
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.stopPropagation()
                          window.open(task.discord.url, '_blank', 'noopener')
                        }
                      }}
                    >
                      Discord
                    </span>
                  ) : null}
                </span>
              ) : null}
            </span>
            <Icon name="chevron" size={16} />
          </button>
          )
        })}
      </div>

      {/* 「アーカイブ済み (N)」トグル（既定 OFF・D92）。N はサーバの `archivedCount` */}
      {archivedShown > 0 ? (
        <button
          type="button"
          className={`archived-toggle${showArchivedTasks ? ' on' : ''}`}
          aria-pressed={showArchivedTasks}
          onClick={() => {
            haptic('tap')
            setShowArchivedTasks((v) => !v)
          }}
        >
          {t('tasks.archivedToggle', { n: archivedShown })}
          {showArchivedTasks ? ' ✓' : ''}
        </button>
      ) : null}
      {showArchivedTasks && archivedShown > 0 && !tasks.some(isArchivedTask) ? (
        <div className="empty">{t('tasks.archivedEmpty')}</div>
      ) : null}

      <button className="kill-open" onClick={() => setKillOpen(true)}>
        <Icon name="bolt" size={18} />
        {t('tasks.emergency')}
      </button>

      {killOpen ? (
        <Sheet title={t('tasks.emergencyTitle')} onClose={() => !busy && setKillOpen(false)}>
          {/* (1) カンバン・タスク緊急停止（Kanban Workers）— 最優先はこの 1 ボタン */}
          <div className="kill-section">
            <span className="kill-section-title">{t('tasks.emergencyKanbanHead')}</span>
            <span className="kill-section-sub">{t('tasks.emergencyKanbanSub')}</span>
          </div>
          <div className="warn-card">{t('tasks.emergencyNote', { n: running })}</div>
          <div className="hold-grid">
            <HoldButton
              label={t('tasks.stopAllLabel')}
              sub={t('tasks.stopAllSub')}
              tone="danger"
              disabled={busy}
              onFire={stopAllAction}
            />
          </div>
          <div className="warn-card" style={{ marginTop: 8 }}>
            {paused.engaged
              ? t('tasks.pausedNow', { at: paused.engagedAt ?? t('tasks.unknownTime') })
              : t('tasks.pauseHelp')}
          </div>
          {paused.engaged ? (
            <button className="btn" style={{ marginTop: 10, width: '100%' }} onClick={resumeAction} disabled={busy}>
              {t('tasks.resumeEstop')}
            </button>
          ) : (
            <div className="hold-grid">
              <HoldButton
                label={t('tasks.pauseLabel')}
                sub={t('tasks.pauseSub')}
                tone="safe"
                disabled={busy}
                onFire={pauseAction}
              />
            </div>
          )}

          {/* (2) Hermes Gateway 操作（Bot / 通信）— カンバンのタスクは止まらない */}
          <div className="kill-section">
            <span className="kill-section-title">{t('tasks.emergencyGatewayHead')}</span>
            <span className="kill-section-sub">{t('tasks.emergencyGatewaySub')}</span>
          </div>
          <div className="row-sub" style={{ padding: '0 4px 8px' }}>{t('tasks.gatewayNote')}</div>
          <div className="hold-grid">
            <HoldButton
              label={t('tasks.drainLabel')}
              sub={t('tasks.drainSub')}
              tone="safe"
              disabled={busy}
              onFire={() => gatewayAction('drain')}
            />
            <HoldButton
              label={t('tasks.restartLabel')}
              sub={t('tasks.restartSub')}
              tone="danger"
              disabled={busy}
              onFire={() => gatewayAction('restart')}
            />
            <HoldButton
              label={t('tasks.stopLabel')}
              sub={t('tasks.stopSub')}
              tone="danger"
              disabled={busy}
              onFire={() => gatewayAction('stop')}
            />
            <HoldButton
              label={t('tasks.startLabel')}
              sub={t('tasks.startSub')}
              tone="safe"
              disabled={busy}
              onFire={() => gatewayAction('start')}
            />
          </div>
          <div className="row-sub" style={{ padding: '10px 4px' }}>
            {t('tasks.auditNote')}
          </div>
        </Sheet>
      ) : null}

      {captureOpen ? (
        <CaptureSheet
          board={board}
          boards={boards}
          notify={notify}
          onClose={() => setCaptureOpen(false)}
          onCreated={(task) => {
            if (board && task?.board === board) loadTasks(board)
            else if (task?.board) setBoard(task.board)
          }}
        />
      ) : null}

      {usageOpen ? (
        <UsageSheet
          data={usageData}
          hours={24}
          board={board}
          spec={currentSpec?.path ?? null}
          onClose={() => setUsageOpen(false)}
        />
      ) : null}
      {receiptCtx ? (
        <MissionReceiptSheet
          board={receiptCtx.board}
          spec={receiptCtx.spec}
          onClose={() => setReceiptCtx(null)}
          notify={notify}
        />
      ) : null}

      {inboxOpen ? (
        <InboxSheet
          notify={notify}
          onClose={closeInbox}
          onChanged={loadInbox}
          focusTaskId={inboxFocus}
        />
      ) : null}

      {liveOpen ? (
        <LiveSheet
          notify={notify}
          onClose={() => setLiveOpen(false)}
          onAbortTask={() => board && loadTasks(board)}
        />
      ) : null}

      </div>

      {/* タスク詳細（Sheet / >=820px の右ペイン）。取得・ポーリング・差分は TaskDetailSheet 側 */}
      <TaskDetailSheet
        target={detailTarget}
        fallbackBoard={board}
        mode={split ? 'split' : 'sheet'}
        notify={notify}
        onClose={closeDetail}
        onChanged={(targetBoard) => {
          if (targetBoard) loadTasks(targetBoard)
          refresh?.()
        }}
      />
    </div>
  )
}
