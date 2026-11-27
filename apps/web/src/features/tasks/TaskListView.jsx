/**
 * タスク一覧の描画（CSW3-7）。
 *
 * `.list-head` からアーカイブ切替まで、**一覧の見た目だけ**を持つ:
 * 状態バナー・進行バー・起動チップ・SPEC バー・統計ストリップ・ボード行・
 * 整理モードの操作帯・行・空状態・アーカイブ切替。取得と反映は
 * `useTasksData` / `useSpecLaunchpad` が持ち、ここは props で受け取る。
 *
 * 行の key（`task.id` / `b.id`）・空状態の文言・スクロール位置は変えない。
 */
import React from 'react'
import { HoldButton, Icon, Loader, RefreshButton, relTime } from '../../components/Ui.jsx'
import { haptic } from '../../lib/haptic.js'
import { ArchitectJobBar } from '../../components/ArchitectJobBar.jsx'
import { CoherenceBanner } from '../../components/CoherenceBanner.jsx'
import { SpecReadyBanner } from '../../components/SpecReadyBanner.jsx'
import { SpecRunningBar } from '../../components/SpecRunningBar.jsx'
import { AutopilotSwipeLink } from '../autopilot/AutopilotView.jsx'
import { fmtCost, sep } from '../../lib/format.js'
import { readActiveChatId, reportSummaryLine, toEpochMs } from '../../lib/chatReports.js'
import { useI18n } from '../../i18n/index.js'
import {
  archivedTaskCount,
  archivableTasks,
  isArchivedTask,
  organizeRowView,
  selectableBrokenTasks,
  visibleTasks,
} from '../../lib/tasksView.js'
import { STATUS_KEY } from './TaskDetailSheet.jsx'

export function TaskListView({
  tasks = [],
  loading = false,
  boards = [],
  board = null,
  boardMeta,
  paused = { engaged: false },
  resumeAction,
  busy = false,
  usageData = null,
  liveTurns = 0,
  architectRunning = 0,
  inboxCount = 0,
  openInbox,
  activeJob = null,
  specsInfo = null,
  notify,
  inspectArchitectJob,
  loadArchitectJobs,
  loadSpecs,
  setArchitectJobClosed,
  specBanner = null,
  architectFiling = false,
  fileSpecBatches,
  setArchitectDismissed,
  openSpecMd,
  archiveBannerSpec,
  activeSpecRun = null,
  openTask,
  pickSpec,
  setSpecSheetOpen,
  coherenceView = null,
  coherenceOpen = false,
  setCoherenceOpen,
  openCoherenceSweep,
  dismissCoherence,
  setSeedInitial,
  setSeedOpen,
  setBrainstormInitial,
  setBrainstormOpen,
  setRefactorPreset,
  setRefactorOpen,
  currentSpec = null,
  specAllDone = false,
  openSpecHistory,
  openSpecSheet,
  latestReport = null,
  latestReportBody = null,
  idle = true,
  reportRecent = false,
  discussLatestReport,
  openReceipt,
  bridge = null,
  mem = null,
  disk = null,
  setUsageOpen,
  setLiveOpen,
  setBoardSheetOpen,
  reviewWaiting = 0,
  setCaptureOpen,
  refreshAll,
  showArchivedTasks,
  setShowArchivedTasks,
  archivedTaskTotal = 0,
  organize,
  setOrganize,
  organizeSel = [],
  setOrganizeSel,
  organizeBusy = false,
  bulkArchiveSelected,
}) {
  const { t } = useI18n()

  // 一覧の表示（D92）: 既定はアーカイブを隠し、N はサーバの件数を優先する。
  const archivedShown = archivedTaskCount(tasks, archivedTaskTotal)
  const shownTasks = visibleTasks(tasks, showArchivedTasks)
  const organizeTargets = archivableTasks(tasks)
  const brokenSelection = selectableBrokenTasks(tasks)
  const running = tasks.filter((task) => task.status === 'running').length
  const currentBoard = boards.find((b) => b.slug === board) ?? null

  return (
    <>
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

      {reviewWaiting > 0 ? (
        <div className="ap-swipe-strip"><AutopilotSwipeLink count={reviewWaiting} /></div>
      ) : null}
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
    </>
  )
}
