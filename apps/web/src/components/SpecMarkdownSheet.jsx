import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Loader, Sheet, relTime } from './Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { renderMarkdown } from '../lib/markdown.js'
import { useI18n } from '../i18n/index.js'

/**
 * 仕様書（`docs/SPEC-*.md`）の全文プレビュー（SPEC-PILOT-V6 §3.4 ② / D30）。
 *
 * 3 つの入口（Launchpad シート・バッチ履歴シート・新着 SPEC バナー）から同じ 1 枚を開く。
 * 本文は `GET /api/specs/content?board=&repo=&path=` で取る（ブリッジ側がリポジトリ境界を
 * 検査するので、ここではパスを信用して組み立てない — そのままクエリに載せるだけ）。
 *
 * 読み取り専用: 編集も保存もしない。閉じる（✕）は `Sheet` の履歴連動の戻るを使うので、
 * Android の戻るでもこの 1 枚だけが閉じる。
 *
 * @param {{board?: string|null, repo?: string|null, path: string, title?: string|null,
 *          onClose: Function}} props 対象（`board` か `repo` のどちらかは必須）
 * @returns {any} シート
 */
export function SpecMarkdownSheet({ board = null, repo = null, path, title = null, onClose }) {
  const { t } = useI18n()
  const [state, setState] = useState({ loading: true, data: null, error: null })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    setState({ loading: true, data: null, error: null })
    const qs = new URLSearchParams()
    if (board) qs.set('board', board)
    if (repo) qs.set('repo', repo)
    if (path) qs.set('path', path)
    api(`/api/specs/content?${qs.toString()}`)
      .then((d) => {
        if (alive) setState({ loading: false, data: d, error: null })
      })
      .catch((e) => {
        if (alive) setState({ loading: false, data: null, error: e?.message ?? t('tasks.specMdFailed') })
      })
    return () => {
      alive = false
    }
  }, [board, repo, path, t])

  /** 本文（またはコードブロック）をクリップボードへ。失敗しても画面は壊さない。 */
  const copyText = useCallback(
    async (text) => {
      try {
        await globalThis.navigator?.clipboard?.writeText?.(text)
        haptic('tap')
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      } catch {
        /* クリップボードが使えない環境（http や権限なし）では何もしない */
      }
    },
    [],
  )

  const data = state.data

  return (
    <Sheet title={t('tasks.specMdTitle')} onClose={onClose}>
      <div className="spec-md-meta">
        <span className="spec-md-path mono" title={data?.path ?? path}>
          {data?.path ?? path}
        </span>
        <span className="spec-md-sub">
          {[
            data?.batchCount ? t('tasks.specBatchCount', { n: data.batchCount }) : null,
            data?.mtime ? t('tasks.specUpdated', { when: relTime(data.mtime) }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <div className="spec-md-actions">
        <button
          type="button"
          className="btn spec-md-copy"
          disabled={!data?.markdown}
          onClick={() => {
            haptic('action')
            copyText(data?.markdown ?? '')
          }}
        >
          {copied ? t('tasks.specMdCopied') : t('tasks.specMdCopy')}
        </button>
        <button
          type="button"
          className="btn spec-md-close"
          onClick={() => {
            haptic('tap')
            onClose?.()
          }}
        >
          {t('tasks.specMdBack')}
        </button>
      </div>
      {data?.truncated ? <div className="spec-md-warn">{t('tasks.specMdTruncated')}</div> : null}
      <div className="spec-md-body">
        {state.loading ? <Loader label={t('tasks.specMdLoading')} /> : null}
        {state.error ? <div className="spec-md-error">{state.error}</div> : null}
        {data?.markdown
          ? renderMarkdown(data.markdown, {
              onCopyCode: copyText,
              copyLabel: t('tasks.specMdCopyCode'),
            })
          : null}
      </div>
    </Sheet>
  )
}
