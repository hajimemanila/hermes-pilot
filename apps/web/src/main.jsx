import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.jsx'
import { I18nProvider } from './i18n/index.js'
import { initTheme } from './lib/theme.js'
import './styles.css'

// 最初の描画より前にテーマを当てる（React の effect を待つと Dark が一瞬見える）
initTheme()

createRoot(document.getElementById('root')).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
