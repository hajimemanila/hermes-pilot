import React, { useRef, useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { HoldButton, Icon, Sheet, relTime } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { CaptureSheet } from './CaptureSheet.jsx'
import { UsageSheet } from './UsageSheet.jsx'
import { MissionReceiptSheet } from './MissionReceiptSheet.jsx'
import { SpecSeedSheet } from './SpecSeedSheet.jsx'
import { BrainstormSheet, RefactorSheet } from './TaskToolSheets.jsx'
import { SpecMarkdownSheet } from '../components/SpecMarkdownSheet.jsx'
import { LiveSheet } from './LiveSheet.jsx'
import { InboxSheet } from './InboxSheet.jsx'
import { BoardPickerSheet } from './tasks/BoardPickerSheet.jsx'
import { readActiveChatId } from '../lib/chatReports.js'
import { renderMarkdown } from '../lib/markdown.js'
import { useI18n } from '../i18n/index.js'
import { useSplitLayout } from '../lib/useSplitLayout.js'
import { bulkArchivePayload } from '../lib/tasksView.js'
import { HM_EVENTS, emitHmEvent } from '../contracts/events.js'
import { ModePill, SpecPicker } from './tasks/SpecPicker.jsx'
import { STATUS_KEY, TaskDetailSheet } from './tasks/TaskDetailSheet.jsx'
import { useTasksData } from './tasks/useTasksData.js'
import { useSpecLaunchpad } from './tasks/useSpecLaunchpad.js'
import { TaskListView } from './tasks/TaskListView.jsx'


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

  const running = tasks.filter((task) => task.status === 'running').length
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
      <TaskListView
        tasks={tasks}
        loading={loading}
        boards={boards}
        board={board}
        boardMeta={boardMeta}
        paused={paused}
        resumeAction={resumeAction}
        busy={busy}
        usageData={usageData}
        liveTurns={liveTurns}
        architectRunning={architectRunning}
        inboxCount={inboxCount}
        openInbox={openInbox}
        activeJob={activeJob}
        specsInfo={specsInfo}
        notify={notify}
        inspectArchitectJob={inspectArchitectJob}
        loadArchitectJobs={loadArchitectJobs}
        loadSpecs={loadSpecs}
        setArchitectJobClosed={setArchitectJobClosed}
        specBanner={specBanner}
        architectFiling={architectFiling}
        fileSpecBatches={fileSpecBatches}
        setArchitectDismissed={setArchitectDismissed}
        openSpecMd={openSpecMd}
        archiveBannerSpec={archiveBannerSpec}
        activeSpecRun={activeSpecRun}
        openTask={openTask}
        pickSpec={pickSpec}
        setSpecSheetOpen={setSpecSheetOpen}
        coherenceView={coherenceView}
        coherenceOpen={coherenceOpen}
        setCoherenceOpen={setCoherenceOpen}
        openCoherenceSweep={openCoherenceSweep}
        dismissCoherence={dismissCoherence}
        setSeedInitial={setSeedInitial}
        setSeedOpen={setSeedOpen}
        setBrainstormInitial={setBrainstormInitial}
        setBrainstormOpen={setBrainstormOpen}
        setRefactorPreset={setRefactorPreset}
        setRefactorOpen={setRefactorOpen}
        currentSpec={currentSpec}
        specAllDone={specAllDone}
        openSpecHistory={openSpecHistory}
        openSpecSheet={openSpecSheet}
        latestReport={latestReport}
        latestReportBody={latestReportBody}
        idle={idle}
        reportRecent={reportRecent}
        discussLatestReport={discussLatestReport}
        openReceipt={openReceipt}
        bridge={overview?.bridge ?? null}
        mem={overview?.system?.memory ?? null}
        disk={overview?.system?.disk ?? null}
        setUsageOpen={setUsageOpen}
        setLiveOpen={setLiveOpen}
        setBoardSheetOpen={setBoardSheetOpen}
        reviewWaiting={overview?.counts?.reviewWaiting ?? 0}
        setCaptureOpen={setCaptureOpen}
        refreshAll={refreshAll}
        showArchivedTasks={showArchivedTasks}
        setShowArchivedTasks={setShowArchivedTasks}
        archivedTaskTotal={archivedTaskTotal}
        organize={organize}
        setOrganize={setOrganize}
        organizeSel={organizeSel}
        setOrganizeSel={setOrganizeSel}
        organizeBusy={organizeBusy}
        bulkArchiveSelected={bulkArchiveSelected}
      />




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
