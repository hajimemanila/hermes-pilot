/**
 * Spec Launchpad（SPEC §5.4）: SPEC の一覧選択・バッチの起票・履歴・仕様書プレビュー。
 *
 * SPEC-COHERENCE-SWEEP-3 CSW3-6 で `features/TasksPane.jsx` から移動した（挙動は変えない）。
 * SPEC 一覧そのものの取得は `useTasksData.js` が持ち、この hook は `specsInfo` を受け取る。
 */
import { useMemo, useState } from 'react'
import { api } from '../../api.js'
import { haptic } from '../../lib/haptic.js'
import { celebrate } from '../../lib/vibe.js'
import { readActiveChatId } from '../../lib/chatReports.js'
import { activeSpecRunSummary, specProgress } from '../../lib/specProgress.js'
import { specPickerList } from '../../lib/tasksView.js'
import { useI18n } from '../../i18n/index.js'

export function useSpecLaunchpad({
  board,
  tasks,
  specsInfo,
  specPath,
  setSpecPath,
  loadSpecs,
  loadArchitectJobs,
  loadTasks,
  notify,
}) {
  const { t } = useI18n()
  const [specSheetOpen, setSpecSheetOpen] = useState(false)
  const [specSel, setSpecSel] = useState([])
  const [specBusy, setSpecBusy] = useState(false)
  // 全バッチ完了後に開く履歴（Q3=A）。起票シートとは別のシートにする
  const [specHistoryOpen, setSpecHistoryOpen] = useState(false)
  // 上部 SPEC セレクタのアコーディオン（SPEC-PILOT-V6 §3.5 ① / D29）。シートを開くたびに閉じる
  const [specPickerOpen, setSpecPickerOpen] = useState(false)
  // 仕様書（MD）プレビュー（§3.4 ② / D30）。`{path, title}` を渡して 1 枚のシートを開く
  const [specMd, setSpecMd] = useState(null)
  // Launchpad のバッチ 1 行ごとの「仕様・Verify ▾」展開（チェックボックス選択とは独立）
  const [specBatchOpen, setSpecBatchOpen] = useState([])
  // Launchpad の「Show archived (N)」トグル（既定 OFF＝アクティブ SPEC だけ。D84）
  const [specShowArchived, setSpecShowArchived] = useState(false)
  // バッチ履歴ドロワーは過去分もすぐ参照できるよう、既定でアーカイブ済みも表示する
  const [historyShowArchived, setHistoryShowArchived] = useState(true)
  const [historySpecPath, setHistorySpecPath] = useState(null)

  /* Spec Launchpad（SPEC §5.4）: 既定選択は未起票バッチのみ。 */
  const specParts = { active: specsInfo?.active ?? [], archived: specsInfo?.archived ?? [] }
  const activeSpecRun = useMemo(() => activeSpecRunSummary(specParts.active, tasks), [specParts.active, tasks])
  const specArchivedCount = specParts.archived.length
  // `Show archived` の状態で並びを切り替える（既定はアクティブのみ・純関数でテスト済み）
  const specList = specPickerList(specParts, specShowArchived)
  const currentSpec = specList.find((s) => s.path === specPath) ?? specList[0] ?? null
  /* 起票・完了判定は lib/specProgress.js（allDone 時は履歴を開く・Q3=A / D91・D92）。 */
  const specOpts = { specMtime: currentSpec?.mtime ?? null, runTaskIds: currentSpec?.runTaskIds ?? null }
  const specProg = specProgress(currentSpec?.batches ?? [], tasks, currentSpec?.path, specOpts)
  const filedBatchIds = new Set(specProg.byId.keys())
  const openBatchIds = new Set(
    [...specProg.byId.entries()]
      .filter(([, task]) => task.status !== 'done' && task.status !== 'archived')
      .map(([id]) => id),
  )
  const specAllDone = specProg.allDone
  const historySpecList = specPickerList(specParts, historyShowArchived)
  const historySpec =
    historySpecList.find((s) => s.path === historySpecPath) ?? currentSpec ?? historySpecList[0] ?? null
  const historyProg = specProgress(historySpec?.batches ?? [], tasks, historySpec?.path, {
    specMtime: historySpec?.mtime ?? null,
    runTaskIds: historySpec?.runTaskIds ?? null,
  })
  /**
   * 起票シートで既定選択する（＝まだ起票していない）バッチ ID。
   *
   * `archived`（破棄済み）は完了ではないので**未起票として選び直せる**（D92 の再起票導線）。
   */
  const unfiledBatchIds = (prog, batches) =>
    (Array.isArray(batches) ? batches : [])
      .filter((b) => {
        const t = prog?.byId?.get(b?.id)
        return !t || t.status === 'archived'
      })
      .map((b) => b.id)
  const defaultSelection = () => unfiledBatchIds(specProg, currentSpec?.batches ?? [])

  /** バッチ選択シートを開く（未起票のバッチを既定で選択）。 */
  const openSpecSheet = () => {
    if (!currentSpec) return
    haptic('tap')
    setSpecSel(defaultSelection())
    setSpecPickerOpen(false)
    setSpecBatchOpen([])
    setSpecSheetOpen(true)
  }

  /** 全バッチ完了後の履歴シートを開く（Q3=A）。過去 SPEC もすぐ参照できるようアーカイブも開く。 */
  const openSpecHistory = () => {
    if (!currentSpec && !historySpecList.length) return
    haptic('tap')
    setHistorySpecPath(currentSpec?.path ?? null)
    setHistoryShowArchived(true)
    setSpecPickerOpen(false)
    setSpecHistoryOpen(true)
  }

  /** 上部セレクタで SPEC を切り替え、Launchpad では切替先 SPEC の未起票を選び直す（SPEC V6 §3.5 ①）。 */
  const pickSpec = (next, forLaunch = false) => {
    if (!next) return
    setSpecPath(next.path)
    setSpecPickerOpen(false)
    setSpecBatchOpen([])
    if (forLaunch) {
      const prog = specProgress(next.batches ?? [], tasks, next?.path, {
        specMtime: next?.mtime ?? null,
        runTaskIds: next?.runTaskIds ?? null,
      })
      setSpecSel(unfiledBatchIds(prog, next.batches ?? []))
    }
  }

  /**
   * SPEC をアーカイブへ退避する（`POST /api/specs/archive`・D92）。
   *
   * ファイルは消さない。ヘッダに `- **Status**: archived` が 1 行足されるだけで、
   * Launchpad の「アーカイブ済み」側へ移る（既にアーカイブ済みなら `noop`）。
   */
  const archiveCurrentSpec = async (spec = null) => {
    const target = spec ?? currentSpec
    if (!target?.path || !board) return
    try {
      const r = await api('/api/specs/archive', {
        method: 'POST',
        body: { board, repo: specsInfo?.repo ?? null, path: target.path },
      })
      notify(r?.noop ? t('tasks.specArchiveNoop') : t('tasks.specArchiveDone'))
      await Promise.all([loadSpecs(board), loadArchitectJobs()])
    } catch (e) {
      notify(e?.message || t('tasks.specArchiveFailed'))
    }
  }

  /** A2B 通知カード（SpecReadyBanner）から未起票 SPEC を直接アーカイブ退避する。 */
  const archiveBannerSpec = async (banner) => {
    if (!banner?.path || (!banner?.board && !board)) return
    try {
      const r = await api('/api/specs/archive', {
        method: 'POST',
        body: { board: banner?.board ?? board, repo: specsInfo?.repo ?? null, path: banner.path },
      })
      notify(r?.noop ? t('tasks.specArchiveNoop') : t('tasks.specArchiveDone'))
      await Promise.all([loadSpecs(board), loadArchitectJobs()])
    } catch (e) {
      notify(e?.message || t('tasks.specArchiveFailed'))
    }
  }

  /** 仕様書（MD）プレビューを開く（§3.4 ② / D30。3 箇所の入口から同じシート）。 */
  const openSpecMd = (spec) => {
    const p = typeof spec === 'string' ? spec : spec?.path
    if (!p) return
    haptic('tap')
    setSpecMd({
      path: p,
      title: typeof spec === 'string' ? null : (spec?.title ?? null),
      // バナー由来はジョブのボード（別ボードの仕様書でも正しいリポジトリで読む）
      board: typeof spec === 'string' ? null : (spec?.board ?? null),
    })
  }

  /** 選んだバッチを 1 タップで一括起票し、そのまま自走に乗せる。 */
  const launchBatches = async () => {
    if (!currentSpec || !specSel.length || !board) return
    setSpecBusy(true)
    try {
      const r = await api('/api/specs/launch', {
        method: 'POST',
        body: {
          board,
          specRelPath: currentSpec.path,
          batchIds: specSel,
          // 直近に操作していた会話へ紐づける（完走レポートの宛先・§3.2 ② / §3.3 ③）
          chat: readActiveChatId(globalThis.localStorage) || undefined,
        },
      })
      // 一括起票の祝祭（SPEC-PILOT-V5 §3.1 / D24: Dopamine は演出＋音、Serotonin は触覚だけ）
      celebrate('launch')
      notify(t('tasks.specLaunched', { created: (r.created ?? []).length, skipped: (r.skipped ?? []).length }))
      setSpecSheetOpen(false)
      setSpecSel([])
      await Promise.all([loadTasks(board), loadArchitectJobs(), loadSpecs(board)])
    } catch (e) {
      notify(e.message)
    } finally {
      setSpecBusy(false)
    }
  }

  return {
    // 選択中の SPEC と進捗
    currentSpec, specList, specArchivedCount, activeSpecRun, specProg, filedBatchIds,
    openBatchIds, specAllDone, historySpecList, historySpec, historyProg,
    // シートの開閉・選択
    specSheetOpen, setSpecSheetOpen, specSel, setSpecSel, specBusy, specPickerOpen,
    setSpecPickerOpen, specBatchOpen, setSpecBatchOpen, specShowArchived, setSpecShowArchived,
    specHistoryOpen, setSpecHistoryOpen, historyShowArchived, setHistoryShowArchived,
    historySpecPath, setHistorySpecPath, specMd, setSpecMd,
    // 操作
    openSpecSheet, openSpecHistory, pickSpec, archiveCurrentSpec, archiveBannerSpec, openSpecMd,
    launchBatches,
  }
}
