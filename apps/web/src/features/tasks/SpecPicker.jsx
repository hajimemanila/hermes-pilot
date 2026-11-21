/**
 * タスクタブの SPEC 周りの小さな表示部品（モードピル / SPEC セレクタ）。
 * `TasksPane.jsx` から分割した（挙動は変えない）。
 */
import React from 'react'

/**
 * Execution Mode → バッチ横のモードピル辞書キー（SPEC V5 §3.2）。
 * `mode` が無い過去 SPEC のバッチではピルを出さない。
 */
const MODE_KEY = {
  'zero-stop': 'tasks.modeZeroStop',
  'fast-track-review': 'tasks.modeFastTrack',
  'visual-gate': 'tasks.modeVisualGate',
}

/**
 * バッチのモードピル（未宣言なら null）。
 * @param {{mode?: string|null}} batch バッチ
 * @param {(key: string) => string} t 翻訳
 * @returns {React.ReactElement|null} ピル
 */
export function ModePill({ batch, t }) {
  const key = MODE_KEY[batch?.mode]
  if (!key) return null
  return <span className={`spec-mode is-${batch.mode}`}>{t(key)}</span>
}

/**
 * 上部の SPEC セレクタ（SPEC-PILOT-V6 §3.5 ① / D29）。
 *
 * 既定は**選択中の 1 件だけ**を `.pick-item.spec-now` の 1 行で出す。タップすると
 * 下に `.pick-list.spec-accordion` が開き、別の SPEC を選ぶと自動で閉じる
 * （SPEC が増えても一覧が本題のバッチを画面下へ押し流さない）。
 *
 * 表示は増えうる一覧なので横スクロールにせず縦積み（UI 統一の規約）。
 *
 * @param {{specList: Array<object>, currentSpec: object|null, open: boolean,
 *          onToggle: Function, onPick: Function, t: Function}} props
 * @returns {any} セレクタ（1 行 ＋ 任意でアコーディオン）
 */
export function SpecPicker({
  specList,
  currentSpec,
  open,
  onToggle,
  onPick,
  t,
  archivedCount = 0,
  showArchived = false,
  onToggleArchived = null,
}) {
  if (!currentSpec) return null
  const others = (specList ?? []).filter((s) => s.path !== currentSpec.path)
  // 展開する中身があるか（他の SPEC、または「Show archived」トグル）。
  // アクティブが 1 件でもアーカイブがあれば開ける（完了済みを見に行く導線を残す）。
  const canExpand = others.length > 0 || Boolean(archivedCount > 0 && onToggleArchived)
  const sub = (s) =>
    [
      t('tasks.specBatchCount', { n: (s.batches ?? []).length }),
      s.mtime ? t('tasks.specUpdated', { when: relTime(s.mtime) }) : null,
    ]
      .filter(Boolean)
      .join(' · ')
  return (
    <>
      <button
        type="button"
        className="pick-item spec-now"
        aria-expanded={canExpand ? open : undefined}
        aria-label={t('tasks.specNowAria', { name: currentSpec.title })}
        onClick={() => {
          haptic('tap')
          onToggle()
        }}
      >
        <span className="pick-main">
          <span className="pick-title">
            <span aria-hidden="true">📄</span> {currentSpec.title}
          </span>
          <span className="pick-sub">{`${sub(currentSpec)} · ${currentSpec.path}`}</span>
        </span>
        <span className="pick-meta">
          {canExpand ? t('tasks.specCountOf', { n: specList.length }) : null}
          {canExpand ? <span aria-hidden="true">{open ? '▴' : '▾'}</span> : null}
        </span>
      </button>
      {open && canExpand ? (
        <div className="pick-list spec-accordion">
          {others.map((s) => (
            <button
              key={s.path}
              type="button"
              className={`pick-item${s.archived ? ' is-archived' : ''}`}
              onClick={() => {
                haptic('tap')
                onPick(s)
              }}
            >
              <span className="pick-main">
                <span className="pick-title">
                  {s.archived ? <span className="spec-archived-pill">{t('tasks.specArchivedPill')}</span> : null}
                  {s.title}
                </span>
                <span className="pick-sub">{sub(s)}</span>
              </span>
              <span className="pick-meta" aria-hidden="true">
                ›
              </span>
            </button>
          ))}
          {/* 完了済み SPEC は既定で隠す（Launchpad が過去で埋まらないようにする。D84）。
              アーカイブが 1 件でもあるときだけ「Show archived (N)」を出す。 */}
          {archivedCount > 0 && onToggleArchived ? (
            <button
              type="button"
              className={`pick-item spec-archived-toggle${showArchived ? ' on' : ''}`}
              aria-pressed={showArchived}
              onClick={() => {
                haptic('tap')
                onToggleArchived(!showArchived)
              }}
            >
              <span className="pick-main">
                <span className="pick-title">
                  {showArchived
                    ? t('tasks.specHideArchived')
                    : t('tasks.specShowArchived', { n: archivedCount })}
                </span>
              </span>
              <span className="pick-meta" aria-hidden="true">
                {showArchived ? '−' : '+'}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
