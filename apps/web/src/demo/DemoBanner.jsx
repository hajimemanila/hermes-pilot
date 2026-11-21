/**
 * デモ用の 4 ステップガイドバー（SPEC-PILOT-V5 §3.4 ③）。
 *
 * アプリ最上部に「いま何ステップ目か」「次に何を押すか」「そのステップへ飛ぶボタン」を出す。
 * ステップの判定は `mockApi.js` の `stepIndex(progress)` だけで決める（画面側で推測しない）。
 *
 * 既存画面への誘導は **本番と同じ CustomEvent**（`hm:open-review` / `hm:open-board`）で行う。
 * デモ専用の裏口を作らないので、デモで動く導線は本番でもそのまま動く。
 */

import React, { useEffect, useState } from 'react'
import { useI18n } from '../i18n/index.js'
import { haptic } from '../lib/haptic.js'
import './demo.css'
import { STEPS, resetDemoState, snapshot, subscribeDemo } from './mockApi.js'
import { HM_EVENTS, emitHmEvent } from '../contracts/events.js'

/** ステップごとの誘導先（既存のイベント名を使う）。 */
const JUMPS = {
  1: { event: HM_EVENTS.OPEN_REVIEW, detail: { taskId: 't_demo_review' } },
  2: { event: HM_EVENTS.OPEN_BOARD, detail: { board: 'mobile' } },
  3: { event: HM_EVENTS.OPEN_REVIEW, detail: { taskId: 't_demo_visual' } },
  4: { event: HM_EVENTS.OPEN_BOARD, detail: { board: 'mobile' } },
}

export function DemoBanner() {
  const { t } = useI18n()
  const [state, setState] = useState(() => snapshot())

  useEffect(() => subscribeDemo((_kind, next) => setState(next)), [])

  const step = state.step || 1
  const jump = JUMPS[step]

  const go = () => {
    haptic('tap')
    if (!jump) return
    // 遷移先のペインはタブ切替後にマウントされ、一覧の取得も待つ。
    // 1 回だけだと「まだマウント前」で取りこぼすので、数回まで送り直す（受信側は nonce で冪等）。
    for (const delay of [0, 160, 600, 1200]) {
      setTimeout(() => emitHmEvent(jump.event, jump.detail), delay)
    }
  }

  return (
    <div className="demo-banner" role="region" aria-label={t('demo.bannerAria')}>
      <div className="demo-banner-head">
        <span className="demo-banner-step">{t('demo.stepOf', { n: step, total: STEPS })}</span>
        <span className="demo-banner-title">{t(`demo.steps.${step}.title`)}</span>
        <div className="demo-dots" aria-hidden="true">
          {Array.from({ length: STEPS }, (_, i) => (
            <i key={i} className={`demo-dot${i + 1 < step ? ' past' : i + 1 === step ? ' on' : ''}`} />
          ))}
        </div>
      </div>
      <div className="demo-banner-hint">
        <span>{t(`demo.steps.${step}.hint`)}</span>
        <button
          type="button"
          className="demo-banner-restart"
          title={t('demo.restart')}
          aria-label={t('demo.restart')}
          onClick={() => {
            haptic('action')
            resetDemoState()
            globalThis.location?.reload?.()
          }}
        >
          ↺
        </button>
        <button type="button" className="btn demo-banner-go" onClick={go}>
          {t('demo.takeMe')}
        </button>
      </div>
    </div>
  )
}
