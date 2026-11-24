/**
 * タスク詳細（モバイルは Sheet、820px 以上は 2 ペインの右側）。
 *
 * `TasksPane.jsx` から分割した（挙動は変えない）。取得・ポーリング・差分アコーディオン・
 * 中断／クローズまでをこのシートに閉じ込め、親は「どのタスクを開いているか」だけを持つ。
 *
 * @param {object} props
 * @param {{id: string, board?: string, title?: string, seq?: number}|null} props.target
 *        開いているタスク（null で閉じる）。`seq` は明示的な開き直し（同じ id を再タップ）用。
 * @param {string} props.fallbackBoard `target.board` が無いときの取得先（= 表示中のボード）。
 * @param {'sheet'|'split'} [props.mode] `sheet` は Sheet を内側で出し、`split` は右ペインを出す。
 * @param {(msg: string) => void} [props.notify] トースト。
 * @param {() => void} [props.onClose] シートを閉じる（親は target を null にする）。
 * @param {(board: string) => void} [props.onChanged] 中断／クローズ後に一覧を取り直す。
 */
import React, { useEffect, useState } from 'react'
import { api } from '../../api.js'
import { HoldButton, Icon, Loader, Sheet, Spinner, relTime } from '../../components/Ui.jsx'
import { CloseActions } from '../../components/CloseActions.jsx'
import { localizeError } from '../../i18n/lang.js'
import { useI18n } from '../../i18n/index.js'
import { sep } from '../../lib/format.js'
import { collapseTaskEvents } from '../../lib/tasksView.js'
import { HM_EVENTS, emitHmEvent } from '../../contracts/events.js'
import { WorkerFeed } from '../ReviewPane.jsx'
import { refreshSync, setSyncParams, setSyncState, subscribeSync } from '../../lib/syncSources.js'

/**
 * タスク状態 → 辞書キー（未知は生の値）。
 * 一覧の行も同じ対応表を使うので、`TasksPane.jsx` から参照できるよう export する。
 */
export const STATUS_KEY = {
  running: 'tasks.status.running',
  ready: 'tasks.status.ready',
  done: 'tasks.status.done',
  blocked: 'tasks.status.blocked',
  failed: 'tasks.status.failed',
  archived: 'tasks.status.archived',
  todo: 'tasks.status.todo',
}

/**
 * タスク詳細の中身（取得済みの `detail` を受けて描く）。
 *
 * @param {object} props
 * @param {object} props.detail 詳細 API の応答（`board` 付き）
 * @param {string} props.board 取得先ボード（別ボードのタスクを開いたときの取り違えを防ぐ）
 * @param {object|null} props.diff 差分サマリ
 * @param {object|null} props.patch 1 ファイルのパッチ
 * @param {boolean} props.aborting 中断の実行中
 * @param {(id: string) => void} props.onToggleDiff 差分アコーディオンの開閉
 * @param {(id: string, file: string) => void} props.onPickPatch 1 ファイルのパッチ表示
 * @param {(task: object) => void} props.onAbort 中断
 * @param {() => void} props.onClosed 中断以外のクローズ（done / archived / 完了）後
 * @param {(msg: string) => void} [props.notify] トースト
 * @returns {React.ReactElement} 本文
 */
function DetailBody({ detail, board, diff, patch, aborting, onToggleDiff, onPickPatch, onAbort, onClosed, notify }) {
  const { t } = useI18n()
  const detailBoard = board
  return (
    <>
      <div className="kv">
        <span>{t('tasks.status')}</span>
        <b>
          {STATUS_KEY[detail.status] ? t(STATUS_KEY[detail.status]) : detail.status}
          {detail.workerPid ? ` ${sep()} pid ${detail.workerPid}` : ''}
        </b>
      </div>
      <div className="kv">
        <span>{t('tasks.started')}</span>
        <b>{detail.startedAt ? relTime(detail.startedAt) : '—'}</b>
      </div>
      {detail.branch ? (
        <div className="kv">
          <span>{t('tasks.branch')}</span>
          <b className="mono">{detail.branch}</b>
        </div>
      ) : null}
      {detail.body ? <div className="body-text">{detail.body}</div> : null}
      {detail.result ? <div className="body-text result">{detail.result}</div> : null}

      {detail.git?.head ? (
        <>
          <div className="kv">
            <span>{t('tasks.commit')}</span>
            <b className="mono">
              {detail.git.head}
              {detail.git.branch ? ` (${detail.git.branch})` : ''}
            </b>
          </div>
          <div className="kv">
            <span>{t('tasks.message')}</span>
            <b className="git-msg">{detail.git.subject || '—'}</b>
          </div>
          <button className="accordion" onClick={() => onToggleDiff(detail.id)}>
            <span className="acc-title">
              {t('tasks.changedFiles')}
              {diff?.ok ? (
                <span className="diff-sum">
                  <span className="add">+{diff.total.add}</span> <span className="del">−{diff.total.del}</span>
                </span>
              ) : null}
            </span>
            <span className="acc-caret">{diff ? '▾' : '▸'}</span>
          </button>
          {diff ? (
            diff.loading ? (
              <div className="row-sub hm-btn-inner" style={{ padding: '6px 4px' }}>
                <Spinner size={12} />
                <span>{t('common.loading')}</span>
              </div>
            ) : diff.ok ? (
              <div className="diff-list">
                {(diff.files ?? []).map((f) => (
                  <div key={f.path}>
                    <button
                      className={`diff-row${patch?.path === f.path ? ' on' : ''}`}
                      onClick={() => onPickPatch(detail.id, f.path)}
                    >
                      <span className="diff-path mono">{f.path}</span>
                      <span className="diff-nums">
                        {f.binary ? (
                          <span className="git-dirty">binary</span>
                        ) : (
                          <>
                            <span className="add">+{f.add}</span> <span className="del">−{f.del}</span>
                          </>
                        )}
                      </span>
                    </button>
                    {patch?.path === f.path ? (
                      patch.loading ? (
                        <div className="row-sub hm-btn-inner" style={{ padding: '6px 10px' }}>
                          <Spinner size={12} />
                          <span>{t('common.loading')}</span>
                        </div>
                      ) : patch.ok ? (
                        <pre className="patch">{patch.text}</pre>
                      ) : (
                        <div className="row-sub" style={{ padding: '6px 10px' }}>
                          {localizeError(patch)}
                        </div>
                      )
                    ) : null}
                  </div>
                ))}
                {!(diff.files ?? []).length ? <div className="empty">{t('tasks.noDiff')}</div> : null}
                {diff.truncated ? <div className="row-sub">{t('tasks.diffLimit')}</div> : null}
                {diff.dirty ? <div className="row-sub">{t('tasks.dirtyNote')}</div> : null}
              </div>
            ) : (
              <div className="row-sub" style={{ padding: '6px 4px' }}>
                {localizeError(diff)}
              </div>
            )
          ) : null}
        </>
      ) : null}

      {detail.discord?.url ? (
        <button className="btn dc-btn" onClick={() => window.open(detail.discord.url, '_blank', 'noopener')}>
          {t('tasks.openThread')}
        </button>
      ) : null}

      {detail.status === 'running' || detail.workerPid ? (
        <div style={{ marginTop: 12 }}>
          <HoldButton
            label={t('tasks.abortTask')}
            sub={t('tasks.abortSub')}
            tone="danger"
            disabled={aborting}
            onFire={() => onAbort(detail)}
          />
        </div>
      ) : detail.status && detail.status !== 'done' && detail.status !== 'archived' ? (
        <div style={{ marginTop: 12 }}>
          <CloseActions board={detailBoard} taskId={detail.id} notify={notify} onClosed={onClosed} />
        </div>
      ) : null}

      {detail.sessionId ? (
        <div style={{ marginTop: 12 }}>
          <WorkerFeed taskId={detail.id} open={detail.status === 'running' || detail.status === 'ready'} topic="taskDetailWorker" />
        </div>
      ) : null}

      <div className="list-head" style={{ marginTop: 16 }}>
        <span>{t('tasks.events')}</span>
      </div>
      <div className="timeline">
        {collapseTaskEvents(detail.events ?? []).map((e, i) => {
          const merged = e.kind === 'heartbeat' && e.count > 1
          return (
            <div key={i} className="tl">
              <span className="tl-dot" />
              <span className="tl-main">
                <span className="row-title">
                  {merged ? t('tasks.heartbeatCount', { n: e.count }) : e.kind}
                </span>
                <span className="row-sub">
                  {merged
                    ? t('tasks.heartbeatRange', { first: relTime(e.firstAt), last: relTime(e.at) })
                    : relTime(e.at)}
                </span>
              </span>
            </div>
          )
        })}
        {!(detail.events ?? []).length ? <div className="empty">{t('tasks.noEvents')}</div> : null}
      </div>
    </>
  )
}

/**
 * タスク詳細シート本体。`target` を deps にして取得し、実行中／待機中はポーリングする。
 *
 * @param {object} props `TaskDetailSheet` の props（冒頭の JSDoc を参照）
 * @returns {React.ReactElement|null} Sheet（`sheet`）／右ペイン（`split`）／null
 */
export function TaskDetailSheet({ target, fallbackBoard, mode = 'sheet', notify, onClose, onChanged }) {
  const { t } = useI18n()
  // 取得結果は「どの target のものか」を key で持つ（古い応答で新しいタスクを上書きしない）
  const [fetched, setFetched] = useState({ key: '', detail: null, loading: false, failed: false })
  const [diff, setDiff] = useState(null)
  const [patch, setPatch] = useState(null)
  const [aborting, setAborting] = useState(false)

  const targetId = String(target?.id ?? '').trim()
  const targetBoard = String(target?.board ?? fallbackBoard ?? '').trim()
  // 明示的な開き直し（同じ id をタップし直した）だけ取得し直す。オブジェクトの作り直しでは再取得しない
  const targetSeq = target?.seq ?? 0
  const key = targetId ? `${targetBoard}|${targetId}|${targetSeq}` : ''

  // 取得先（開いているタスク）を取得関数へ渡す。購読より先に走らせる。
  useEffect(() => {
    setSyncParams({ taskDetail: targetId ? { board: targetBoard, id: targetId } : null })
    return () => setSyncParams({ taskDetail: null })
  }, [targetId, targetBoard])

  useEffect(() => {
    if (!targetId) {
      setFetched({ key: '', detail: null, loading: false, failed: false })
      setDiff(null)
      setPatch(null)
      return undefined
    }
    const myKey = `${targetBoard}|${targetId}|${targetSeq}`
    setFetched({ key: myKey, detail: null, loading: true, failed: false })
    setDiff(null)
    setPatch(null)
    // 取得は表の `taskDetail`（1 トピック 1 取得）。ここは値を反映するだけ。
    const apply = (d, meta) => {
      if (meta?.error) {
        notify?.(meta.error.message)
        setFetched({ key: myKey, detail: null, loading: false, failed: true })
        return
      }
      if (!d || d.id !== targetId) return
      setFetched((prev) =>
        prev.key === myKey
          ? { key: myKey, detail: { ...(prev.detail ?? {}), ...d, board: targetBoard }, loading: false, failed: false }
          : prev,
      )
    }
    const off = subscribeSync('taskDetail', apply)
    refreshSync('taskDetail')
    return off
    // notify は毎レンダー作り直される素の関数。target が変わった時だけ取り直せば足りる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, targetBoard, targetSeq])

  const state = fetched.key === key ? fetched : { key, detail: null, loading: Boolean(key), failed: false }
  const detail = state.detail
  const board = String(detail?.board ?? fallbackBoard ?? '')

  /**
   * 実行中／待機中のあいだだけ詳細を再同期する（表の `taskDetail` = 5 秒・`enabledWhen: detailActive`）。
   * 完了後は開いたときの 1 回で足りる。
   */
  const detailStatus = detail?.status ?? null
  useEffect(() => {
    setSyncState({ detailActive: Boolean(targetId) && (detailStatus === 'running' || detailStatus === 'ready') })
  }, [targetId, detailStatus])

  /** 差分サマリ（アコーディオンを開いたときだけ取りに行く）。 */
  const toggleDiff = async (id) => {
    if (diff?.loading) return
    if (diff) {
      setDiff(null)
      return
    }
    setDiff({ loading: true })
    try {
      const d = await api(`/api/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(id)}/diff`)
      setDiff(d)
    } catch (e) {
      setDiff({ ok: false, reason: e.message })
    }
  }

  /** 1ファイルのパッチ。 */
  const loadPatch = async (id, file) => {
    if (patch?.path === file) {
      setPatch(null)
      return
    }
    setPatch({ path: file, loading: true })
    try {
      const d = await api(
        `/api/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(id)}/diff?file=${encodeURIComponent(file)}`,
      )
      setPatch({ ...d, path: file })
    } catch (e) {
      setPatch({ path: file, ok: false, reason: e.message })
    }
  }

  /** 実行中タスクの中断。成功したら閉じて一覧を取り直す。 */
  const abortTask = async (task) => {
    setAborting(true)
    const abortBoard = String(task?.board ?? board).trim()
    try {
      const r = await api(
        `/api/boards/${encodeURIComponent(abortBoard)}/tasks/${encodeURIComponent(task.id)}/abort`,
        {
          method: 'POST',
          body: { reason: t('tasks.abortReason') },
        },
      )
      if (r?.ok === false) {
        notify?.(r?.error || r?.output || t('live.abortFailed', { id: task.id }))
        return
      }
      notify?.(t('tasks.aborted', { reclaim: r.reclaimed, block: r.blocked }))
      emitHmEvent(HM_EVENTS.WAKE_SYNC)
      onClose?.()
      onChanged?.(abortBoard)
    } catch (e) {
      notify?.(e.message)
    } finally {
      setAborting(false)
    }
  }

  /** 中断以外のクローズ（done / archived / 完了）。 */
  const closedTask = () => {
    emitHmEvent(HM_EVENTS.WAKE_SYNC)
    onClose?.()
    onChanged?.(board)
  }

  const body = (
    <DetailBody
      detail={detail}
      board={board}
      diff={diff}
      patch={patch}
      aborting={aborting}
      onToggleDiff={toggleDiff}
      onPickPatch={loadPatch}
      onAbort={abortTask}
      onClosed={closedTask}
      notify={notify}
    />
  )
  const title = detail?.title ?? target?.title ?? targetId
  const content = detail ? (
    body
  ) : state.loading ? (
    <Loader label={t('tasks.detailLoading')} />
  ) : null

  if (mode === 'split') {
    return (
      <div className="split-detail">
        {detail || state.loading ? (
          <>
            <div className="split-detail-head">
              <span className="split-detail-title">{title}</span>
              <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
                <Icon name="close" size={18} />
              </button>
            </div>
            <div className="split-detail-body">{content}</div>
          </>
        ) : (
          <div className="split-placeholder">
            <b>{t('tasks.selectPlaceholder')}</b>
            <span>{t('tasks.selectHint')}</span>
          </div>
        )}
      </div>
    )
  }

  // Sheet は取得に失敗したら出さない（従来どおり）
  if (!detail && !state.loading) return null
  return (
    <Sheet title={title} onClose={onClose}>
      {content}
    </Sheet>
  )
}
