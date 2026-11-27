/**
 * 進行バー・仕様バナー・定型チップ帯（`jobBar` / `specBanner` / `actionBar`）と、
 * その材料（Architect ジョブの取得・起票・アーカイブ・MD プレビュー）を
 * `ChatPane.jsx` から切り出した（`docs/SPEC-COHERENCE-SWEEP-3.md` §3.3 / Batch CSW3-5）。
 *
 * 移動のみ: 値・文字列・分岐・順序・依存配列は変えていない。3 つのノードを組み立てて
 * 返すだけのフックなので、`ChatPane` は 1 ペインと 2 カラムの両方で同じノードを使う。
 * state（`specJobs` / `specFiling` / `specDismissed` / `specJobClosed` / `specMd`）は
 * ここが持つ — 進行バーの × とバナーの × が同じ配列を読み書きするため、2 か所に割らない。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArchitectJobBar } from '../../components/ArchitectJobBar.jsx'
import { SpecReadyBanner } from '../../components/SpecReadyBanner.jsx'
import { SpecMarkdownSheet } from '../../components/SpecMarkdownSheet.jsx'
import { pickActiveArchitectJob, pickSpecBanner } from '../../lib/specSeed.js'
import { isOfflineError } from '../../lib/netRecovery.js'
import { refreshSync, setSyncState, subscribeSync, tickSync } from '../../lib/syncSources.js'
import { HM_EVENTS, emitHmEvent } from '../../contracts/events.js'
import { celebrate } from '../../lib/vibe.js'
import { haptic } from '../../lib/haptic.js'
import { api } from '../../api.js'
import { t } from '../../i18n/lang.js'

/**
 * @param {object} args
 * @param {boolean} args.active このタブが見えているか
 * @param {boolean} args.seedOpen 📝 Seed シートが開いているか
 * @param {object|null} args.repo いまのリポジトリ
 * @param {string|null} args.sid いま話している会話
 * @param {string|null} args.activeDrawerSid 画面に出している会話
 * @param {(msg: string) => void} args.notify
 * @param {object} args.bars 定型チップ帯の表示トグル
 * @param {Array} args.hotSnippets 帯に出す定型文
 * @param {object|null} args.readonly 読み取り専用で開いている会話
 * @param {boolean} args.streaming 応答が流れているか
 * @param {(snippet: object, coarse?: boolean) => void} args.insertSnippet
 * @param {(v: boolean) => void} args.setSnippetSheet 定型文シート
 */
export function useChatChrome({
  active,
  seedOpen,
  repo,
  sid,
  activeDrawerSid,
  notify,
  bars,
  hotSnippets,
  readonly,
  streaming,
  insertSnippet,
  setSnippetSheet,
}) {
  // 仕様書の準備完了（A2B クイック起票カード・§3.2 D23）。
  const [specJobs, setSpecJobs] = useState(null)
  const [specFiling, setSpecFiling] = useState(false)
  const [specDismissed, setSpecDismissed] = useState([])
  // 仕様書(MD)プレビュー（SPEC-PILOT-V6 §3.4 ② / D30 ③）。バナーから 1 タップで開く
  const [specMd, setSpecMd] = useState(null)
  // 進行バーで × を押したジョブ（`failed` の再表示を止める。SPEC V6 §3.3 ②）
  const [specJobClosed, setSpecJobClosed] = useState([])
  // 定型チップの長押し判定（押下ごとに作り直す）
  const pressRef = useRef({})

  /**
   * A2B クイック起票カードの材料（`GET /api/architect/jobs`・SPEC V5 §3.2 D23）。
   *
   * Architect が仕様書を書き終えた瞬間にバナーを出すため、表示中は 20 秒ごとに見る。
   * 旧ブリッジ（404）では黙ってカードを出さない。
   *
   * ボード未選択（リポジトリ未指定の会話）でも必ず取得する（SPEC-PILOT-V9 §3.3 ③）。
   * ブリッジの `jobsFor()` はアクティブジョブをボード横断で返すので、別ボードで走っている
   * Architect の進行バーもチャットから消えない。
   */
  const seedBoard = repo?.boards?.[0]?.slug ?? ''
  /** ジョブ一覧の応答を反映する（取得は表の `architectJobs` = TasksPane と共有する 1 回）。 */
  const applySpecJobs = useCallback((d, meta) => {
    if (meta?.error) {
      if (!isOfflineError(meta.error)) setSpecJobs(null)
      return
    }
    if (d?.ok) setSpecJobs(d)
  }, [])

  const loadSpecJobs = useCallback(async () => {
    const r = await refreshSync('architectJobs')
    applySpecJobs(r.value, { error: r.error })
  }, [applySpecJobs])

  /* 進行バーはチャットを見ている間だけ（表の `architectJobs`・進行中は 4 秒）。 */
  useEffect(() => {
    if (!active && !seedOpen) return undefined
    const off = subscribeSync('architectJobs', applySpecJobs)
    tickSync('architectJobs')
    return off
  }, [active, seedOpen, applySpecJobs])

  /** 進行バーに出すジョブ（SPEC V6 §3.3 ②）。`spec_ready` / `launched` はバナーが引き継ぐ。 */
  const activeJob = useMemo(
    () => pickActiveArchitectJob(specJobs?.jobs ?? [], specJobClosed, seedBoard),
    [specJobs, specJobClosed, seedBoard],
  )

  /* 進行中（running / awaiting_spec）だけ 4 秒へ切り替える（表の `architectJobs.everyMsOf`）。 */
  useEffect(() => {
    if (!active) return
    setSyncState({
      architectBusy: Boolean(activeJob && (activeJob.status === 'running' || activeJob.status === 'awaiting_spec')),
    })
  }, [active, activeJob])

  /**
   * 進行バーの「🔍 進捗詳細」（SPEC-PILOT-V9 §3.3 ③ / D43 後半）。
   *
   * チャットにはタスク詳細も `LiveSheet` も無いので、`App` が受け取るイベントで振り分ける:
   * - `taskId` あり … `hm:open-task`（タスクタブへ切り替えてそのタスク詳細／WorkerFeed）
   * - `taskId` なし … `hm:open-live`（カンバンタスクを持たない Agy Opt-in の全体監視）
   *
   * 送信名は条件式で組み立てず、契約ごとにリテラルで書く（`contracts.test.js` が
   * `required` と送信リテラルを突き合わせるため・SPEC D108）。
   */
  const inspectArchitectJob = useCallback((job) => {
    if (!job) return
    haptic('tap')
    if (job.taskId) {
      emitHmEvent(HM_EVENTS.OPEN_TASK, {
        taskId: job.taskId,
        board: job.board ?? seedBoard ?? null,
        jobId: job.id ?? null,
      })
      return
    }
    emitHmEvent(HM_EVENTS.OPEN_LIVE, { jobId: job.id ?? null })
  }, [seedBoard])

  /** 出すカードは 1 枚だけ（完成 SPEC 優先・× で閉じたものは再表示しない）。 */
  const specBanner = useMemo(() => {
    const picked = pickSpecBanner({ specReady: specJobs?.specReady ?? [], pending: specJobs?.pending ?? [] })
    if (!picked || specDismissed.includes(picked.path)) return null
    return picked
  }, [specJobs, specDismissed])

  /** バナーから未起票バッチを一括起票する（既起票はブリッジ側でスキップ）。 */
  const fileSpecBatches = useCallback(
    async (banner) => {
      if (!banner || specFiling) return
      setSpecFiling(true)
      try {
        const r = await api('/api/specs/launch', {
          method: 'POST',
          body: {
            ...(seedBoard ? { board: seedBoard } : {}),
            specRelPath: banner.path,
            batchIds: banner.ids,
            ...(sid ? { chat: sid } : {}),
          },
        })
        notify(t('seed.bannerFiled', { n: (r?.created ?? []).length }))
        try {
          celebrate('launch')
        } catch {
          /* 演出は本質ではない */
        }
        await loadSpecJobs()
      } catch (e) {
        notify(e?.message ?? t('seed.failed'))
      } finally {
        setSpecFiling(false)
      }
    },
    [seedBoard, specFiling, sid, notify, t, loadSpecJobs],
  )

  /** バナーや MD プレビューから未起票 SPEC をアーカイブ退避する（D92）。 */
  const archiveSpecBanner = useCallback(
    async (banner) => {
      if (!banner?.path) return
      try {
        const targetBoard = banner?.board ?? (seedBoard || null)
        const targetRepo = banner?.board && banner.board !== seedBoard ? null : (repo?.id ?? null)
        const r = await api('/api/specs/archive', {
          method: 'POST',
          body: { board: targetBoard, repo: targetRepo, path: banner.path },
        })
        notify(r?.noop ? t('tasks.specArchiveNoop') : t('tasks.specArchiveDone'))
        await loadSpecJobs()
      } catch (e) {
        notify(e?.message ?? t('tasks.specArchiveFailed'))
      }
    },
    [seedBoard, repo?.id, notify, t, loadSpecJobs],
  )

  /* Architect の進行バー（SPEC V6 §3.3 ②） */
  const jobBar = (
    <>
      {/* Architect の進行バー（SPEC V6 §3.3 ②）: Seed のあと「今どこか」を画面上部に残す */}
      <ArchitectJobBar
        job={activeJob}
        board={seedBoard}
        repo={repo?.id ?? null}
        chat={sid ?? activeDrawerSid ?? null}
        onInspect={inspectArchitectJob}
        onRetried={() => loadSpecJobs()}
        onDismiss={async (jobId) => {
          // バーがサーバー側へ破棄を永続化したあとに呼ばれる。ローカルでも閉じ、取得し直して
          // 「破棄済みが一覧から消えた」ことを実データで確認する（SPEC V7 §3.3 ③）
          setSpecJobClosed((prev) => [...prev, jobId])
          await loadSpecJobs()
        }}
        notify={notify}
      />
    </>
  )

  /* A2B クイック起票カード（SPEC V5 §3.2 D23） */
  const specBannerCard = (
    <>
      {/* A2B クイック起票カード（SPEC V5 §3.2 D23）: 仕様書ができた瞬間に 1 タップで起票 */}
      <SpecReadyBanner
        banner={specBanner}
        busy={specFiling}
        onFile={fileSpecBatches}
        onDismiss={(b) => setSpecDismissed((prev) => [...prev, b.path])}
        onPreview={(b) => setSpecMd({ path: b.path, title: b.title, board: b.board ?? null })}
        onArchive={archiveSpecBanner}
      />
    </>
  )

  /* 定型チップ帯（SPEC-PILOT-V7 §3.4） */
  const actionBar = (
    <>
      {/* 定型チップ帯（設定タブで非表示にできる・SPEC-PILOT-V7 §3.4）。隠したときは
          入力欄の ＋ →「定型文」から同じスニペット一覧を開ける */}
      {bars.chat && (hotSnippets.length || !readonly) ? (
        <div className="action-bar">
          <div className="chips-scroll">
            {hotSnippets.map((s) => (
              <button
                key={s.id}
                className={`snippet-chip${s.trigger ? ' trigger' : ''}`}
                disabled={streaming}
                title={s.text}
                onPointerDown={() => {
                  clearTimeout(pressRef.current?.timer)
                  pressRef.current = { fired: false }
                  pressRef.current.timer = setTimeout(() => {
                    pressRef.current.fired = true
                    insertSnippet(s, true)
                  }, 550)
                }}
                onPointerUp={() => clearTimeout(pressRef.current?.timer)}
                onPointerLeave={() => clearTimeout(pressRef.current?.timer)}
                onPointerCancel={() => clearTimeout(pressRef.current?.timer)}
                onClick={() => {
                  if (pressRef.current?.fired) {
                    pressRef.current.fired = false
                    return
                  }
                  insertSnippet(s)
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button className="snippet-chip add" onClick={() => setSnippetSheet(true)} aria-label={t('chat.snippetListAria')}>
            <span className="snippet-chip-add-glyph">+</span>
          </button>
        </div>
      ) : null}
    </>
  )

  /* 仕様書(MD)プレビュー（SPEC-PILOT-V6 §3.4 ② / D30）。バナーと同じ 1 枚をここでも開く */
  const specMdSheet = specMd ? (
    <SpecMarkdownSheet
      board={specMd.board ?? (seedBoard || null)}
      repo={specMd.board && specMd.board !== seedBoard ? null : (repo?.id ?? null)}
      path={specMd.path}
      title={specMd.title}
      onClose={() => setSpecMd(null)}
      onArchived={() => loadSpecJobs()}
    />
  ) : null

  return { seedBoard, loadSpecJobs, jobBar, specBannerCard, actionBar, specMdSheet }
}
