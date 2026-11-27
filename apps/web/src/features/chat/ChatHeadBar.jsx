/**
 * 会話を開く入口の見た目（プロファイル札・リポジトリ札、ヘッダ、2 カラムの最小ヘッダ、
 * 新規会話シート）を `ChatPane.jsx` から切り出した（`docs/SPEC-COHERENCE-SWEEP-3.md`
 * §3.3 / Batch CSW3-4）。
 *
 * 移動のみ: 値・文字列・分岐・`className` は変えていない。state（タイトル・未読数・
 * 開いている会話・シートの段）は `ChatPane.jsx` の責務のままなので、ここは props を
 * そのまま描くだけ。`ChatNewChatSheet` だけは「＋」から開く新規会話の経路
 * （プロファイル選択 → リポジトリ選択 → ボード選択 / ボード作成）を 1 か所に閉じる。
 */

import React from 'react'
import { Icon, RefreshButton, Sheet } from '../../components/Ui.jsx'
import { boardSummary, repoLabel } from '../../lib/repoPicker.js'
import { haptic } from '../../lib/haptic.js'
import { t } from '../../i18n/lang.js'

/** プロファイル札・リポジトリ札（1 ペインはヘッダ内・2 カラムは左の下端スタック）。 */
export function ChatChips({ profile, pilotDefault, repo, onOpenProfileSheet }) {
  return (
    <>
      <span
        className={`prof-chip${profile !== pilotDefault ? ' on' : ''}`}
        title={t('chat.profileTitle', { profile })}
      >
        {profile}
      </span>
      {repo ? (
        <button
          className="prof-chip repo-chip"
          title={t('chat.repoTitle', { id: repo.id, path: repo.path })}
          aria-label={t('chat.repoTitleShort', { id: repo.id })}
          onClick={() => {
            haptic('tap')
            onOpenProfileSheet()
          }}
        >
          {repo.id}
        </button>
      ) : null}
    </>
  )
}

/** 1 ペインのヘッダ（2 カラムでは出さない: 一覧は左カラムが持つ）。 */
export function ChatHead({ title, drawerUnread, otherUnreads, dcLink, chips, onOpenDrawer, onNewChat, onRefresh }) {
  return (
    <div className="chat-head">
      <button
        className="icon-btn"
        onClick={() => {
          haptic('tap')
          onOpenDrawer()
        }}
        aria-label={drawerUnread ? t('chat.sessionsAria', { n: drawerUnread }) : t('chat.sessions')}
      >
        <Icon name="grid" size={18} />
        {drawerUnread ? (
          <span className="drawer-btn-badge" aria-hidden="true">
            {drawerUnread}
          </span>
        ) : null}
        {!drawerUnread && otherUnreads.length ? <span className="nav-dot done" aria-hidden="true" /> : null}
      </button>
      <span className="chat-title">{title || t('chat.title')}</span>
      {chips}
      {dcLink?.url ? (
        <button
          className="icon-btn dc-icon"
          title={`Discord: ${dcLink.chatName ?? ''}`}
          aria-label={t('chat.discordAria')}
          onClick={() => {
            haptic('tap')
            window.open(dcLink.url, '_blank', 'noopener')
          }}
        >
          <span aria-hidden="true">#</span>
        </button>
      ) : null}
      <RefreshButton variant="icon" ariaLabel={t('chat.refreshChatAria')} onRefresh={onRefresh} />
      <button
        className="icon-btn"
        onClick={() => {
          haptic('tap')
          onNewChat()
        }}
        aria-label={t('chat.newChatAria')}
      >
        <Icon name="plus" size={18} />
      </button>
    </div>
  )
}

/** 右カラムの最小ヘッダ（タイトル・↻・＋だけ。バナーもチップも置かない）。 */
export function ChatMinimalHead({ title, onNewChat, onRefresh }) {
  return (
    <div className="chat-split-head">
      <span className="chat-title">{title || t('chat.title')}</span>
      <RefreshButton variant="icon" ariaLabel={t('chat.refreshChatAria')} onRefresh={onRefresh} />
      <button
        className="icon-btn"
        onClick={() => {
          haptic('tap')
          onNewChat()
        }}
        aria-label={t('chat.newChatAria')}
      >
        <Icon name="plus" size={18} />
      </button>
    </div>
  )
}

/**
 * 新規会話シート（プロファイル → リポジトリ → ボード）。段（`repoStep`）で中身が切り替わる。
 * `open` が false のときは何も描かない（`ChatPane` 側の `{profileSheet ? … : null}` と同じ）。
 */
export function ChatNewChatSheet({
  open,
  repoStep,
  setRepoStep,
  onClose,
  repoPick,
  setRepoPick,
  orderedProfiles,
  pilotDefault,
  pinned,
  lastRepo,
  onPickRepo,
  repos,
  onStart,
  onCreateBoard,
  boardBusy,
}) {
  if (!open) return null
  return (
    <Sheet
      title={
        repoStep?.kind === 'board'
          ? t('chat.chooseBoard')
          : repoStep?.kind === 'create'
            ? t('chat.createBoard')
            : repoStep?.kind === 'all'
              ? t('chat.allRepos')
              : t('chat.newChat')
      }
      onClose={onClose}
    >
      {!repoStep ? (
        <>
          {orderedProfiles.map((p) => (
            <button
              key={p}
              className={`row${repoPick === p ? ' on' : ''}`}
              onClick={() => setRepoPick(p)}
              aria-pressed={repoPick === p}
            >
              <span className="row-main">
                <span className="row-title">
                  {p}
                  {p === pilotDefault ? <span className="prof-chip">{t('chat.defaultChip')}</span> : null}
                  {repoPick === p ? <span className="prof-chip on">{t('chat.selectedChip')}</span> : null}
                </span>
                <span className="row-sub">
                  {p === 'default'
                    ? t('chat.usualWork')
                    : p === pilotDefault
                      ? t('chat.thisDeviceDefault')
                      : t('chat.profileSuffix', { p })}
                </span>
              </span>
              <Icon name={repoPick === p ? 'check' : 'chevron'} size={16} />
            </button>
          ))}

          <div className="sec">{t('chat.repoSection')}</div>
          {pinned.rows.map((r) => (
            <button
              key={r.id}
              className={`row${lastRepo === r.id ? ' on' : ''}`}
              onClick={() => onPickRepo(r)}
              title={t('chat.repoRowTitle', { label: r.label, path: r.path })}
            >
              <span className="row-main">
                <span className="row-title">
                  {repoLabel(r)}
                  {lastRepo === r.id ? <span className="prof-chip">{t('chat.lastChip')}</span> : null}
                </span>
                <span className="row-sub">
                  {boardSummary(r.boards)}
                  {r.boards.length > 1 ? ' ›' : ''}
                </span>
              </span>
              <Icon name="chevron" size={16} />
            </button>
          ))}
          {!repos.length ? (
            <div className="row-sub" style={{ padding: '6px 6px 10px', lineHeight: 1.7 }}>
              {t('chat.reposLoading')}
            </div>
          ) : null}
          {pinned.hidden > 0 ? (
            <button className="row" onClick={() => setRepoStep({ kind: 'all' })}>
              <span className="row-main">
                <span className="row-title">{t('chat.allReposRow')}</span>
                <span className="row-sub">
                  {t('chat.reposHidden', { n: pinned.hidden, total: pinned.total })}
                </span>
              </span>
              <Icon name="chevron" size={16} />
            </button>
          ) : null}
          <button className="row" onClick={() => onStart(repoPick, null, null)}>
            <span className="row-main">
              <span className="row-title">{t('chat.noRepo')}</span>
              <span className="row-sub">{t('chat.noRepoSub')}</span>
            </span>
            <Icon name="chevron" size={16} />
          </button>
          <div className="row-sub" style={{ padding: '10px 6px 18px', lineHeight: 1.7 }}>
            {t('chat.pickProfileThenRepo')}
            {t('chat.boardBecomesDefault')}
          </div>
        </>
      ) : null}

      {repoStep?.kind === 'all' ? (
        <>
          <div className="sec">{t('chat.allReposSection', { n: repos.length })}</div>
          {repos.map((r) => (
            <button
              key={r.id}
              className="row"
              onClick={() => onPickRepo(r)}
              title={t('chat.repoRowTitle', { label: r.label, path: r.path })}
            >
              <span className="row-main">
                <span className="row-title">{repoLabel(r)}</span>
                <span className="row-sub">
                  {boardSummary(r.boards)}
                  {r.boards.length > 1 ? ' ›' : ''}
                </span>
              </span>
              <Icon name="chevron" size={16} />
            </button>
          ))}
        </>
      ) : null}

      {repoStep?.kind === 'board' ? (
        <>
          <div className="sec">{t('chat.repoBoards', { repo: repoLabel(repoStep.repo) })}</div>
          {(repoStep.repo.boards ?? []).map((b) => (
            <button key={b.slug} className="row" onClick={() => onStart(repoPick, repoStep.repo, b)}>
              <span className="row-main">
                <span className="row-title">{b.name || b.slug}</span>
                <span className="row-sub">
                  {b.slug}
                  {b.current ? t('chat.currentBoard') : ''}
                </span>
              </span>
              <Icon name="chevron" size={16} />
            </button>
          ))}
          <div className="row-sub" style={{ padding: '10px 6px 18px', lineHeight: 1.7 }}>
            {t('chat.boardPickNote', { n: repoStep.repo.boards.length })}
          </div>
        </>
      ) : null}

      {repoStep?.kind === 'create' ? (
        <>
          <div className="sec">{t('chat.noBoardsSection')}</div>
          <div className="row-sub" style={{ padding: '6px 6px 12px', lineHeight: 1.7 }}>
            {t('chat.noBoardsBody', { repo: repoLabel(repoStep.repo) })}
          </div>
          <button className="row" onClick={onCreateBoard} disabled={boardBusy} aria-busy={boardBusy}>
            <span className="row-main">
              <span className="row-title">
                {boardBusy ? t('chat.creating') : t('chat.createBoardRow', { id: repoStep.repo.id })}
              </span>
              <span className="row-sub">{repoStep.repo.path}</span>
            </span>
            <Icon name="check" size={16} />
          </button>
          <button className="row" onClick={() => setRepoStep(null)}>
            <span className="row-main">
              <span className="row-title">{t('chat.dontCreate')}</span>
              <span className="row-sub">{t('chat.dontCreateSub')}</span>
            </span>
            <Icon name="chevron" size={16} />
          </button>
        </>
      ) : null}
    </Sheet>
  )
}
