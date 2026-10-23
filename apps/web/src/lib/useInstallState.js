import { useEffect, useState } from 'react'

/**
 * PWA のインストール可否を端末側で判定する。
 *
 * Chrome は「インストール可能」と判断したときだけ `beforeinstallprompt` を発火する。
 * 発火しないなら manifest / アイコン / Service Worker のどこかで要件を満たしていない。
 * メニューの「アプリをインストール」が `This site cannot be installed` になる原因を
 * 端末上で切り分けるために、状態をそのまま画面に出す。
 */
let deferredEvent = null
const listeners = new Set()

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredEvent = e
    listeners.forEach((fn) => fn())
  })
  window.addEventListener('appinstalled', () => {
    deferredEvent = null
    listeners.forEach((fn) => fn())
  })
}

export function useInstallState() {
  const [available, setAvailable] = useState(Boolean(deferredEvent))
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    const update = () => setAvailable(Boolean(deferredEvent))
    listeners.add(update)
    // 発火が遅れることがあるので数秒は監視する
    const timers = [500, 1500, 3000, 6000].map((ms) => setTimeout(update, ms))
    const mq = window.matchMedia?.('(display-mode: standalone)')
    setInstalled(Boolean(mq?.matches))
    return () => {
      listeners.delete(update)
      timers.forEach(clearTimeout)
    }
  }, [])

  return {
    available,
    installed,
    prompt: async () => {
      if (!deferredEvent) return null
      deferredEvent.prompt()
      const r = await deferredEvent.userChoice
      deferredEvent = null
      setAvailable(false)
      return r?.outcome ?? null
    },
  }
}

/** Service Worker が今このページを制御しているか（インストール要件のひとつ）。 */
export function swState() {
  try {
    if (!('serviceWorker' in navigator)) return '非対応'
    if (navigator.serviceWorker.controller) return '制御中'
    return '未制御（再読込で有効化）'
  } catch {
    return '—'
  }
}
