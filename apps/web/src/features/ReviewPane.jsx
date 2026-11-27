import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { CloseActions } from '../components/CloseActions.jsx'
import { Icon, Loader, RefreshButton, Sheet, fmtTime, relTime } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { celebrate } from '../lib/vibe.js'
import { readActiveChatId } from '../lib/chatReports.js'
import { readReviewRepo } from '../lib/repoPicker.js'
import { AnnotationEditor } from './AnnotationEditor.jsx'
import { AutopilotSwipeLink } from './autopilot/AutopilotView.jsx'
import {
  DONE_LIMIT,
  REVIEW_STATUS_KEY,
  doneHint,
  extractRecommendedAnswers,
  groupItems,
  isWaiting,
  nextWaiting,
  reviewChipKey,
  reviewProgressText,
  reviewTabFor,
  shouldFetchSheetData,
  shouldShowModeChip,
} from '../lib/reviewView.js'
import { useI18n } from '../i18n/index.js'
import { useSplitLayout } from '../lib/useSplitLayout.js'
import { sep } from '../lib/format.js'
import { HM_EVENTS, emitHmEvent } from '../contracts/events.js'
import { HM_STORAGE } from '../contracts/storage.js'
import { useWakeSync } from '../lib/useWakeSync.js'
import { Chip } from './review/Chip.jsx'
import { IframeForm, SheetLink, StandardForm } from './review/ReviewForms.jsx'
import { ReadOnlyDetail } from './review/ReviewDetail.jsx'
import { NewAnnotationSheet, prefetchAnnotationData } from './review/AnnotationCreate.jsx'
import { refreshSync, setSyncParams, subscribeSync, tickSync } from '../lib/syncSources.js'

/** WorkerFeed の取得先はトピックが決めるので、トピック → パラメータ名の対応表を 1 つだけ持つ。 */
const WORKER_FEED_PARAM = { reviewDetail: 'reviewDetailId', workerFeed: 'workerFeedId' }

/** レビュービュー（標準は `sheet.json` からネイティブフォーム、既定は判断待ちのみ・送信で次へ）。 */

const TABS = [
  { id: 'generating', key: 'review.tab.generating' },
  { id: 'waiting', key: 'review.tab.waiting' },
  { id: 'reflecting', key: 'review.tab.reflecting' },
  { id: 'done', key: 'review.tab.done' },
]

function ItemRow({ item, onOpen }) {
  const { t } = useI18n()
  const ak = item.review || {}
  const waiting = isWaiting(item)
  const age = item.completedAt || item.createdAt ? relTime(item.completedAt || item.createdAt) : ''
  const phaseLine = reviewProgressText(item, sep())
  const chipKey = reviewChipKey(item)
  return (
    <button
      className="ak-row"
      onClick={() => {
        haptic('tap')
        onOpen(item)
      }}
      type="button"
    >
      <div className="ak-row-main">
        <div className="ak-row-title">{ak.title || item.title}</div>
        <div className="ak-row-sub">
          <span className="ak-label">{ak.label || item.id}</span>
          {ak.round ? <span>r{ak.round}</span> : null}
          {ak.questions ? <span>{t('review.questionsCount', { n: ak.questions })}</span> : null}
          {shouldShowModeChip(ak.mode) ? <span>{ak.mode}</span> : null}
          <span>{age}</span>
        </div>
        {phaseLine ? <div className="ak-row-phase">{phaseLine}</div> : null}
      </div>
      <div className="ak-row-side">
        <Chip tone={waiting ? 'warn' : item.status === 'done' ? 'good' : ''}>
          {chipKey ? t(chipKey) : item.status}
        </Chip>
      </div>
    </button>
  )
}

/**
 * worker（profile mobile）の進行。反映中でも「何をしているか」が見えるようにする。
 *
 * レビュー詳細とタスク詳細（任意のボード）の両方から使うので名前付きで公開する。
 * エンドポイントはトピックが決める（`reviewDetail` / `taskDetailWorker` / `workerFeed`）。
 *
 * @param {{taskId: string, open?: boolean, topic?: string}} props プロパティ
 */
export function WorkerFeed({ taskId, open = false, topic = 'reviewDetail' }) {
  const { t } = useI18n()
  const [feed, setFeed] = useState(null)
  const [error, setError] = useState(null)
  const boxRef = React.useRef(null)

  useEffect(() => {
    const apply = (value, meta) => {
      if (meta?.error) {
        // 直前に unblock した直後はワーカーの session_id がまだ書かれていない（NO_SESSION）ため、
        // 赤エラーにせず「起動待ち」の柔和な表示で次の取得を待つ。
        if (open && meta.error?.code === 'NO_SESSION') {
          setFeed((prev) => prev ?? { status: 'ready', feed: { messages: [] } })
          setError(null)
          return
        }
        setError(meta.error?.message || t('review.loadFailed'))
        return
      }
      if (value == null) return
      setFeed(value)
      setError(null)
    }
    // 取得は表のトピック（1 トピック 1 取得）。どの worker かは取得関数へ id で渡す。
    const paramKey = WORKER_FEED_PARAM[topic]
    if (paramKey) setSyncParams({ [paramKey]: taskId })
    if (!open) {
      // 完了後は開いたときの 1 回で足りる（ライブ更新はしない）
      refreshSync(topic).then((r) => apply(r.value, { error: r.error }))
      return () => {
        if (paramKey) setSyncParams({ [paramKey]: null })
      }
    }
    const off = subscribeSync(topic, apply)
    refreshSync(topic)
    return () => {
      off()
      if (paramKey) setSyncParams({ [paramKey]: null })
    }
  }, [open, taskId, topic, t])

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [feed])

  const msgs = (feed?.feed?.messages || []).filter((m) => m.role !== 'user')
  const statusLabel = feed?.status ? (REVIEW_STATUS_KEY[feed.status] ? t(REVIEW_STATUS_KEY[feed.status]) : feed.status) : null
  const waitingStart = open || feed?.status === 'ready'
  return (
    <details className="ak-worker" open={open}>
      <summary>
        {t('review.workerProgress')}
        {statusLabel ? t('review.workerStatus', { status: statusLabel }) : ''}
        {msgs.length ? t('review.workerSteps', { n: msgs.length }) : ''}
      </summary>
      {error ? <div className="ak-error">{error}</div> : null}
      {!error && !msgs.length ? (
        <div className="ak-worker-empty">{waitingStart ? t('review.workerWaitingStart') : t('review.workerEmpty')}</div>
      ) : null}
      <div className="ak-worker-log" ref={boxRef}>
        {msgs.map((m) => {
          const time = fmtTime(m.at)
          const label = m.role === 'tool' ? m.toolName || 'tool' : 'agent'
          const text = String(m.text || '').replace(/\s+/g, ' ').slice(0, 220)
          return (
            <div className={`ak-worker-row ${m.role}`} key={m.id}>
              <span className="ak-worker-time">{time}</span>
              <span className="ak-worker-tag">{label}</span>
              <span className="ak-worker-text">{text}</span>
            </div>
          )
        })}
      </div>
    </details>
  )
}

export function ReviewPane({ notify, focusRequest = null, onConsumedFocus, active = true }) {
  const { t } = useI18n()
  // >=680px は 2 ペイン（詳細をシートではなく右ペインに出す。SPEC-i18n-resp §2 B3）
  // 境界は lib/layout.js の 1 箇所だけ（CSS の @media と一致させる）
  const { split } = useSplitLayout()
  const [state, setState] = useState({ loading: true, items: [], board: null, error: null })
  const [tab, setTab] = useState('waiting')
  const [open, setOpen] = useState(null)
  const [showNew, setShowNew] = useState(false)
  // 直前に注釈を付けた対象から始める（空に戻ると毎回選び直しになる・SPEC-ver-0-2-1 §2.1）
  const [newTarget, setNewTarget] = useState(() => readReviewRepo())
  const [data, setData] = useState(null)
  const [answer, setAnswer] = useState(null)
  const [dataError, setDataError] = useState(null)
  // `.json` 取得中（取れていない間に <IframeForm> を出さないためのフラグ）
  const [dataLoading, setDataLoading] = useState(false)
  const [closeNote, setCloseNote] = useState('')
  const [showAllDone, setShowAllDone] = useState(false)
  // 一括承認（⚡）の送信中フラグと「全件完了」バナー（SPEC §5.1）
  const [fastBusy, setFastBusy] = useState(false)
  const [allClear, setAllClear] = useState(false)
  // 作業フィード（監視 cron が書く 1 行ログ）。完了・停止を端末で気づくために出す。
  const [feed, setFeed] = useState([])
  const feedNotifiedRef = useRef(0)

  const lastLoadOkRef = useRef(true)
  /** 一覧の応答を反映する（取得は表の `reviewWaiting` = 1 トピック 1 取得）。 */
  const applyItems = useCallback(
    (value, meta) => {
      if (meta?.error) {
        lastLoadOkRef.current = false
        setState((prev) => ({
          loading: false,
          items: prev.items,
          board: prev.board,
          error: meta.error?.message || t('review.loadFailed'),
        }))
        return []
      }
      const items = Array.isArray(value?.items) ? value.items : []
      lastLoadOkRef.current = true
      setState({ loading: false, items, board: value?.board || null, error: null })
      // 下部ナビの丸バッジ（注釈 1377.jpg の赤）を、この一覧と同じデータで同期する
      try {
        emitHmEvent(HM_EVENTS.REVIEW_ITEMS, { items })
      } catch {
        /* noop */
      }
      // 「注釈を作る」シートを開いた瞬間に段階的読み込みにならないよう先読みする
      prefetchAnnotationData()
      return items
    },
    [t],
  )

  const load = useCallback(
    async () => {
      const r = await refreshSync('reviewWaiting')
      return applyItems(r.value, { error: r.error })
    },
    [applyItems],
  )

  const refreshReview = useCallback(async () => {
    await load()
    return lastLoadOkRef.current
  }, [load])

  /* 一覧は表の `reviewWaiting`（15 秒）。マウント中だけ購読する。 */
  useEffect(() => {
    const off = subscribeSync('reviewWaiting', applyItems)
    tickSync('reviewWaiting')
    return off
  }, [applyItems])

  const groups = useMemo(
    () => groupItems(state.items, showAllDone ? Number.MAX_SAFE_INTEGER : DONE_LIMIT),
    [state.items, showAllDone],
  )
  const counts = {
    generating: groups.generating.length,
    waiting: groups.waiting.length,
    reflecting: groups.reflecting.length,
  }
  // シートを開いたときの「1 / N 判断待ち」と一括承認の材料（SPEC §5.1）
  const fastTrack = useMemo(() => extractRecommendedAnswers(data), [data])
  const waitIndex = open ? groups.waiting.findIndex((x) => x.id === open.id) + 1 : 0

  const openItem = useCallback(async (item) => {
    setOpen(item)
    setData(null)
    setAnswer(null)
    setDataError(null)
    setCloseNote('')
    setDataLoading(false)
    const ak = item.review || {}
    // 注釈モードだけは設問 JSON を持たない（赤を描く画面）。それ以外は
    // `mode=sheet` / `mode=standard` / 未指定のどれでも取る（D38）。
    if (!shouldFetchSheetData(ak)) return
    // 進行中・完了も読むだけ開く（bridge の answer() はレビュー待ち以外を 409 で拒否する）。
    // 完了した項目は「レビュー回答（履歴）」を出すため sheet.json と answer.json を取る。
    setDataLoading(true)
    try {
      const r = await api(`/api/review/${item.id}/data`)
      setData(r.data)
      setAnswer(r.answer ?? null)
    } catch (e) {
      // レビュー待ちなら理由を出す。読むだけの項目はシートが無いこともあるので黙る
      if (isWaiting(item)) setDataError(e?.message || t('review.sheetMissing'))
    } finally {
      // 取得中に <IframeForm> へフォールバックさせない（生の HTML が一瞬出るチラつき）
      setDataLoading(false)
    }
  }, [])

  // チャットの完了報告行など外部からの誘導（「このレビュータスク／注釈作成を開く」）を処理する
  useEffect(() => {
    if (!focusRequest || state.loading) return
    if (focusRequest.openNewAnnotation) {
      setNewTarget(focusRequest.target || '')
      setShowNew(true)
      onConsumedFocus?.()
      return
    }
    const found = state.items.find(
      (x) =>
        (focusRequest.taskId && x.id === focusRequest.taskId) ||
        (focusRequest.label && x.review?.label === focusRequest.label),
    )
    if (found) {
      setTab(reviewTabFor(found))
      openItem(found)
    } else {
      setTab('done')
    }
    onConsumedFocus?.()
  }, [focusRequest, state.loading, state.items, openItem, onConsumedFocus])

  function closeSheet() {
    setOpen(null)
    setData(null)
    setAnswer(null)
    setDataError(null)
    setDataLoading(false)
  }

  /**
   * 作業フィードを反映し、開いている間は既読にする（ナビの緑の点を消す）。
   * 新しい「完了」があればトーストで 1 回だけ知らせる（同じ行で二度は出さない）。
   * 取得は表の `reviewFeed`（15 秒・App の未読バッジと同じ 1 回の取得を共有する）。
   */
  const applyFeed = useCallback(
    (value, meta) => {
      if (meta?.error) return // フィードは補助情報
      // 取得は 20 件（App の未読判定が要る）。表示は従来どおり直近 6 行。
      const items = (Array.isArray(value?.items) ? value.items : []).slice(-6)
      setFeed(items)
      const at = Date.now()
      try {
        localStorage.setItem(HM_STORAGE.REVIEW_SEEN_AT, String(at))
      } catch {
        /* noop */
      }
      try {
        emitHmEvent(HM_EVENTS.REVIEW_SEEN, { at })
      } catch {
        /* noop */
      }
      const done = items.filter((n) => n.kind === 'done' || /^✅/.test(String(n.text || '')))
      const latest = done[done.length - 1]
      if (latest && latest.at > feedNotifiedRef.current) {
        // 初回読み込みでは出さない（過去の完了を今の通知として見せない）
        if (feedNotifiedRef.current) {
          notify?.(t('review.feedNotice', { text: String(latest.text).replace(/^✅\s*/, '') }))
        }
        feedNotifiedRef.current = latest.at
      }
    },
    [notify, t],
  )

  const loadFeed = useCallback(async () => {
    const r = await refreshSync('reviewFeed')
    applyFeed(r.value, { error: r.error })
  }, [applyFeed])

  useEffect(() => {
    if (!active) return undefined
    const off = subscribeSync('reviewFeed', applyFeed)
    tickSync('reviewFeed')
    return off
  }, [applyFeed, active])

  useWakeSync(() => {
    load()
    if (active) loadFeed()
  })

  /**
   * 送信後（レビュー回答 Q2-B）: 閉じずに次の判断待ちを開く。
   * 残りが無いときだけ閉じる。送れた実感はトーストで補う。
   */
  async function handleSubmitted(answeredId, result, kind) {
    /*
     * 送信が通った瞬間の祝祭（SPEC-PILOT-V5 §3.1 / D24）。
     * Dopamine はパーティクル・コンボ・効果音、Serotonin は基本ハプティックだけ。
     */
    const celebrateKind = result?.duplicate ? null : kind || (result?.files?.approval ? 'stamp' : 'approve')
    if (celebrateKind) celebrate(celebrateKind)

    const items = await load()
    // 回答直後に他タブ（Chat / Tasks の Architect 進行バー・完了報告・バッジ）が古い状態で残らないよう即時同期を促す
    try {
      emitHmEvent(HM_EVENTS.WAKE_SYNC)
      emitHmEvent(HM_EVENTS.REFRESH_REPORTS)
    } catch {
      /* noop */
    }
    // 検収（approve）は「送信」ではなく「合格」なので、トーストの頭を差し替える
    const head = result?.duplicate
      ? t('review.duplicate')
      : result?.files?.approval
        ? t('annot.approved')
        : t('review.answerSent')
    const next = nextWaiting(items, answeredId)
    if (next) {
      setAllClear(false)
      await openItem(next)
      notify?.(t('review.nextOpened', { head }))
      return
    }
    const answered = items.find((x) => x && x.id === answeredId) || null
    const inProgress = Boolean(answered && ['ready', 'running'].includes(answered.status))
    if (inProgress) {
      // 回答後にワーカーが動くタスクは「反映中」へ移し、回答後の沈黙時間も見失わないようにする
      setTab('reflecting')
      if (split) {
        await openItem(answered)
      } else {
        closeSheet()
      }
    } else {
      setTab('waiting')
      closeSheet()
    }
    // 最後の 1 件を送り終えたら「全件完了」をバナーで知らせる（SPEC §5.1）
    setAllClear(true)
    // 全件消化の祝祭（Dopamine は 🎉 + ファンファーレ、Serotonin は success の触覚だけ）
    celebrate('allClear')
    notify?.(t('review.noneLeft', { head }))
  }

  /** 推奨案で一括承認（SPEC §5.1 / D15①）。推奨の無い問は `choice: null` = お任せ。 */
  async function acceptRecommended() {
    if (!open || fastBusy || !fastTrack.canFastTrack) return
    setFastBusy(true)
    try {
      const r = await api(`/api/review/${open.id}/answer`, {
        method: 'POST',
        body: { answers: fastTrack.answers, global: '', by: 'mobile', chat: readActiveChatId() },
      })
      // 祝祭（多段バイブ・パーティクル・効果音）は送信成功後に handleSubmitted が出す
      await handleSubmitted(open.id, r, 'fastTrack')
    } catch (e) {
      notify?.(e?.message || t('review.fastTrackFailed'))
    } finally {
      setFastBusy(false)
    }
  }

  const hasItems = state.items.length > 0
  const isAnnoOpen = Boolean(open && open.review?.mode === 'annotation' && isWaiting(open))
  const openTitle = open ? (open.review?.title || open.title) + '' : ''

  // 選択中シートの中身（Sheet と右ペインで同一。2 ペインでも挙動を変えない）
  const sheetInner = open ? (
    <>
        {isWaiting(open) && waitIndex > 0 && counts.waiting > 1 ? (
          <div className="ak-wait-bar">
            <span className="ak-wait-pill">{t('review.waitPill', { i: waitIndex, n: counts.waiting })}</span>
          </div>
        ) : null}
        {isWaiting(open) && fastTrack.canFastTrack && data?.questions?.length ? (
          <div className="ak-fasttrack">
            <button
              className="btn fast-track"
              type="button"
              disabled={fastBusy}
              aria-busy={fastBusy}
              onClick={acceptRecommended}
            >
              {fastBusy ? t('review.sending') : t('review.fastTrack', { summary: fastTrack.summary })}
            </button>
            <p className="ak-fasttrack-hint">{t('review.fastTrackHint')}</p>
          </div>
        ) : null}
        {open.review?.mode !== 'annotation' ? <SheetLink item={open} /> : null}
        {isWaiting(open) ? (
          <>
            {dataError ? <div className="ak-error">{t('review.openSheetDirectly', { error: dataError })}</div> : null}
            {data?.questions?.length ? (
              <StandardForm item={open} data={data} onSubmitted={(r) => handleSubmitted(open.id, r)} />
            ) : dataLoading ? (
              <Loader label={t('common.loading')} />
            ) : (
              <IframeForm item={open} onSubmitted={(r) => handleSubmitted(open.id, r)} notify={notify} />
            )}
          </>
        ) : dataLoading && !data ? (
          <Loader label={t('common.loading')} />
        ) : (
          <ReadOnlyDetail
            item={open}
            data={data}
            answer={answer}
            notify={notify}
            onStartAnnotation={(t) => {
              closeSheet()
              setNewTarget(t || '')
              setShowNew(true)
            }}
            onReopened={async () => {
              await load()
              closeSheet()
            }}
            onOpenChat={(chatId) => {
              closeSheet()
              emitHmEvent(HM_EVENTS.OPEN_SESSION, { id: chatId })
            }}
          />
        )}
        {isWaiting(open) ? (
          <div className="ak-form">
            <div className="row-sub">{t('review.closeReasonLabel')}</div>
            <textarea
              className="inp"
              rows={2}
              style={{ marginTop: 6 }}
              value={closeNote}
              onChange={(e) => setCloseNote(e.target.value.slice(0, 400))}
              placeholder={t('review.closeReasonPlaceholder')}
            />
            <CloseActions
              board={open.board || state.board || 'mobile'}
              taskId={open.id}
              note={closeNote}
              notify={notify}
              onClosed={() => {
                setCloseNote('')
                load()
                setTimeout(() => setOpen(null), 600)
              }}
            />
          </div>
        ) : null}
        <WorkerFeed taskId={open.id} open={['running', 'ready'].includes(open.status)} />
    </>
  ) : null

  return (
    <div className={split ? 'pane ak-page split-layout review' : 'pane ak-page'}>
      <div className={split ? 'split-master' : undefined}>
      <div className="ak-head">
        <div>
          <div className="ak-title">{t('review.title')}</div>
          <div className="ak-sub">
            {counts.waiting ? t('review.waitingSub', { n: counts.waiting }) : t('review.noneWaiting')}
          </div>
        </div>
        <span className="ak-head-actions">
          <button className="btn ak-new-btn" type="button" onClick={() => { haptic('tap'); setShowNew(true) }}>{t('review.newAnnotation')}</button>
          <RefreshButton onRefresh={refreshReview} />
        </span>
      </div>
      {counts.waiting > 0 && <div className="ap-swipe-strip"><AutopilotSwipeLink count={counts.waiting} /></div>}

      {/* 全件完了（最後の判断待ちを送り終えたときだけ出す） */}
      {allClear ? (
        <div className="ak-allclear" role="status" aria-live="polite">
          <span>{t('review.allClear')}</span>
          <button
            className="icon-btn"
            type="button"
            aria-label={t('common.close')}
            onClick={() => {
              haptic('tap')
              setAllClear(false)
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      ) : null}

      {/* 作業フィード: 相対時刻で表記し Done リストと揃える */}
      {feed.length ? (
        <div className="ak-feed" aria-live="polite">
          {feed.slice(-3).map((n, i) => (
            <div className="ak-feed-row" key={`${n.at}-${i}`}>
              <span className="ak-feed-at">{relTime(n.at)}</span>
              <span className="ak-feed-text">{n.text}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="chips ak-tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`chip${tab === item.id ? ' on' : ''}`}
            onClick={() => {
              if (tab !== item.id) haptic('tap')
              setTab(item.id)
            }}
          >
            {t(item.key)}
            {item.id !== 'done' && counts[item.id] ? ` ${counts[item.id]}` : null}
          </button>
        ))}
      </div>

      {state.error ? <div className="ak-error">{state.error}</div> : null}
      {state.loading ? <Loader label={t('common.loading')} /> : null}

      {!state.loading && !hasItems ? (
        <div className="empty">
          {t('review.emptyNoSheets')}
          <br />
          {t('review.emptyNoSheetsHint')}
        </div>
      ) : null}

      {!state.loading && hasItems && tab === 'waiting' ? (
        groups.waiting.length ? (
          <section className="ak-group">
            {groups.waiting.map((it) => (
              <ItemRow key={it.id} item={it} onOpen={openItem} />
            ))}
          </section>
        ) : (
          <div className="ak-empty-card">
            <div className="ak-empty-title">{t('review.noneWaiting')}</div>
            <p className="ak-empty-body">{t('review.emptyBody')}</p>
            <button className="ak-empty-btn" type="button" onClick={() => setShowNew(true)}>
              {t('review.emptyNewAnnotation')}
            </button>
            <p className="ak-empty-note">{t('review.emptyNote')}</p>
            <div className="ak-empty-meta">
              {t('review.emptyMeta', { active: counts.generating + counts.reflecting, done: groups.doneTotal })}
            </div>
          </div>
        )
      ) : null}

      {!state.loading && hasItems && tab === 'generating' ? (
        groups.generating.length ? (
          <section className="ak-group">
            {groups.generating.map((it) => (
              <ItemRow key={it.id} item={it} onOpen={openItem} />
            ))}
          </section>
        ) : (
          <div className="empty">{t('review.noGenerating')}</div>
        )
      ) : null}

      {!state.loading && hasItems && tab === 'reflecting' ? (
        groups.reflecting.length ? (
          <section className="ak-group">
            {groups.reflecting.map((it) => (
              <ItemRow key={it.id} item={it} onOpen={openItem} />
            ))}
          </section>
        ) : (
          <div className="empty">{t('review.noReflecting')}</div>
        )
      ) : null}

      {!state.loading && hasItems && tab === 'done' ? (
        <>
          <div className="ak-group-title">
            {showAllDone ? t('review.allDone', { n: groups.doneTotal }) : doneHint(groups.doneTotal)}
          </div>
          {groups.done.length ? (
            <section className="ak-group">
              {groups.done.map((it) => (
                <ItemRow key={it.id} item={it} onOpen={openItem} />
              ))}
            </section>
          ) : null}
          {groups.doneTotal > groups.done.length ? (
            <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setShowAllDone(true)}>
              {t('review.showAllDone', { n: groups.doneTotal - groups.done.length })}
            </button>
          ) : showAllDone && groups.doneTotal > DONE_LIMIT ? (
            <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setShowAllDone(false)}>
              {t('review.showRecentOnly', { n: DONE_LIMIT })}
            </button>
          ) : null}
        </>
      ) : null}

      </div>

      {showNew ? (
        <NewAnnotationSheet
          notify={notify}
          initialTarget={newTarget}
          onClose={() => setShowNew(false)}
          onCreated={async (r) => {
            setShowNew(false)
            // 記憶した対象を state にも反映（この画面は再マウントされない）
            setNewTarget(readReviewRepo())
            await load()
            setOpen({ id: r.taskId, board: r.board || state.board || null, title: r.label, status: 'blocked', review: { mode: 'annotation', label: r.label } })
          }}
        />
      ) : null}

      {/* 1 ペイン（< 820px）は従来どおり全画面被せ。2 ペインなら右ペインに常設する */}
      {!split && isAnnoOpen ? (
        <AnnotationEditor
          item={open} defaultBoard={state.board}
          notify={notify}
          onClose={() => setOpen(null)}
          onSubmitted={(r) => handleSubmitted(open.id, r)}
        />
      ) : null}

      {!split && open && !isAnnoOpen ? (
        <Sheet title={openTitle} onClose={closeSheet}>
          {sheetInner}
        </Sheet>
      ) : null}

      {/* >=820px: 右ペインに選択中のシート／注釈エディタを常設（左の一覧から選ぶだけ） */}
      {split ? (
        <div className="split-detail">
          {open ? (
            isAnnoOpen ? (
              <AnnotationEditor
                item={open} defaultBoard={state.board}
                notify={notify}
                onClose={() => setOpen(null)}
                onSubmitted={(r) => handleSubmitted(open.id, r)}
              />
            ) : (
              <>
                <div className="split-detail-head">
                  <span className="split-detail-title">{openTitle}</span>
                  <button className="icon-btn" onClick={closeSheet} aria-label={t('common.close')}>
                    <Icon name="close" size={18} />
                  </button>
                </div>
                <div className="split-detail-body">{sheetInner}</div>
              </>
            )
          ) : (
            <div className="split-placeholder">
              <b>{t('review.selectPlaceholder')}</b>
              <span>{t('review.selectHint')}</span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
