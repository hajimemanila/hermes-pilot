/**
 * `HM_EVENTS.WAKE_SYNC`（復帰・可視化・回線回復・手動再試行の合図）を購読する共通フック。
 *
 * 最新のハンドラを ref に保持し、リスナーの張り直し無しで再取得を走らせる。
 */
import { useEffect, useRef } from 'react'
import { HM_EVENTS, onHmEvent } from '../contracts/events.js'

/**
 * @param {() => void} handler `HM_EVENTS.WAKE_SYNC` 受信時に呼ぶ関数
 */
export function useWakeSync(handler) {
  const ref = useRef(handler)
  ref.current = handler

  useEffect(() => onHmEvent(HM_EVENTS.WAKE_SYNC, () => ref.current?.()), [])
}
