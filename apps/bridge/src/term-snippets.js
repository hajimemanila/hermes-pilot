import { getCapabilities, serviceCommands } from './capabilities.js'
import { normalizeCustom, normalizeOverrides, langOf, BUILTIN_IDS as CHAT_IDS } from './snippets.js'

/**
 * 端末タブの定型コマンド（SPEC §3.3 / D12）。
 *
 * `run: true` のものだけ**長押しで実行**できる（タップは常に挿入のみ）。
 * 破壊的・不可逆なもの（削除系・kill 系）は載せない。
 *
 * 個人環境のサービス名は**載せない**。再起動・状態確認は
 * `capabilities.serviceManager`（launchd / systemd）で分岐する（SPEC §5.3）。
 *
 * ラベルと説明（note）は en / ja の両文面を持つが、**コマンド文字列（text）は英語 ASCII のみ**
 * （シェルの echo も英語。G2①）。
 */

/** @typedef {{id: string, label: string, text: string, hot?: boolean, run?: boolean, note?: string}} TermSnippet */

const DRAIN = '~/.hermes/.drain_request.json'
const L = '~/.hermes/logs'

/**
 * 既定の並び（SPEC §3.3 の表と同じ順）。`<svc.*>` は Capability 依存。
 * @type {Array<{id: string, hot?: boolean, run?: boolean, en: [string, string], ja: [string, string], text: string | ((svc: ReturnType<typeof serviceCommands>, manager: string) => string)}>}
 */
const TABLE = [
  // --- Hot 6（バーに出す）----------------------------------------------------
  {
    id: 't-pilot-restart',
    hot: true,
    run: true,
    en: ['Restart Pilot', 'Restart Hermes Pilot bridge (4097)'],
    ja: ['Pilot再起動', 'Hermes Pilot ブリッジ(4097)を再起動'],
    text: (svc) => svc.restart,
  },
  {
    id: 't-gw-status',
    hot: true,
    run: true,
    en: ['GW Status', 'Hermes gateway status & PID'],
    ja: ['GW状態', 'gateway の稼働状況・PID'],
    text: 'hermes gateway status',
  },
  {
    id: 't-gw-restart',
    hot: true,
    run: true,
    en: ['Restart GW', 'Restart Hermes gateway'],
    ja: ['GW再起動', 'gateway を再起動'],
    text: 'hermes gateway restart',
  },
  {
    id: 't-drain-restart',
    hot: true,
    run: true,
    en: ['Clear Drain + GW', 'Remove drain marker & restart GW'],
    ja: ['解除+GW再起動', 'ドレイン解除＋gateway再起動'],
    text: `rm -f ${DRAIN} && hermes gateway restart`,
  },
  {
    id: 't-kanban',
    hot: true,
    run: true,
    en: ['Kanban Active', 'List kanban tasks'],
    ja: ['カンバン一覧', 'カンバンのタスク一覧'],
    text: 'hermes kanban list',
  },
  {
    id: 't-gw-log',
    hot: true,
    run: true,
    en: ['GW Log', `Last 80 lines of gateway.log`],
    ja: ['GWログ', 'gateway.log の末尾80行'],
    text: `tail -n 80 ${L}/gateway.log`,
  },

  // --- シート（10個）----------------------------------------------------------
  {
    id: 't-pilot-status',
    run: true,
    en: ['Pilot Status', 'Service status of Hermes Pilot'],
    ja: ['Pilot状態', 'Hermes Pilot のサービス状態'],
    text: (svc) => svc.status,
  },
  {
    id: 't-pair-qr',
    run: true,
    en: ['Pairing QR', 'Show pairing URL & QR in terminal'],
    ja: ['ペアリングQR', 'ペアリングURLとQRを表示'],
    text: 'npx hermes-pilot qr',
  },
  {
    id: 't-verify',
    run: true,
    en: ['Run Verify', 'Run tests, PWA check, and build'],
    ja: ['Verify実行', 'テスト・PWA検査・ビルドを一括実行'],
    text: 'npm run verify',
  },
  {
    id: 't-deploy',
    run: true,
    en: ['Deploy Web', 'Zero-downtime build & swap dist'],
    ja: ['Webデプロイ', '無停止ビルド＆dist入れ替え'],
    text: 'npm run deploy',
  },
  {
    id: 't-drain-clear',
    run: true,
    en: ['Clear Drain', 'Remove drain marker only'],
    ja: ['ドレイン解除', 'ドレインマーカーのみ削除'],
    text: `rm -f ${DRAIN} && echo "drain marker removed"`,
  },
  {
    id: 't-list',
    run: true,
    en: ['Services', 'List Hermes background services'],
    ja: ['サービス一覧', 'hermes 系サービス一覧'],
    text: (svc) => svc.list,
  },
  {
    id: 't-errors',
    run: true,
    en: ['Error Log', 'Last 80 lines of errors.log'],
    ja: ['エラーログ', 'errors.log の末尾80行'],
    text: `tail -n 80 ${L}/errors.log`,
  },
  {
    id: 't-health',
    run: true,
    en: ['Reachability', 'Check HTTP 200 on 9119 & 4097'],
    ja: ['疎通確認', '9119 と 4097 の HTTP 応答確認'],
    text:
      'curl -s -o /dev/null -w "dashboard %{http_code}\\n" http://127.0.0.1:9119/; ' +
      'curl -s -o /dev/null -w "pilot %{http_code}\\n" http://127.0.0.1:4097/healthz',
  },
  {
    id: 't-port',
    run: true,
    en: ['Ports', 'Check listening processes on 9119 & 4097'],
    ja: ['ポート確認', '9119 と 4097 の LISTEN 確認'],
    text: 'lsof -nP -iTCP:9119 -sTCP:LISTEN; lsof -nP -iTCP:4097 -sTCP:LISTEN',
  },
  {
    id: 't-git',
    run: true,
    en: ['Git State', 'Short status & last 3 commits'],
    ja: ['git状態', '差分と直近3コミット'],
    text: 'git status --short && git log --oneline -3',
  },
]

/** 端末スニペットの組み込み ID（overrides の検証に使う）。 */
export const TERM_BUILTIN_IDS = TABLE.map((s) => s.id)

/**
 * 端末スニペットを組み立てる（上書きなしの素の一覧）。
 * @param {{serviceManager?: string, pilotServiceUnit?: string}} [caps] Capability（既定は起動時検出）
 * @param {'en'|'ja'} [lang] 表示言語（既定 en・SPEC D5）
 * @returns {TermSnippet[]} スニペット
 */
export function buildTermSnippets(caps = getCapabilities(), lang = 'en') {
  const svc = serviceCommands(caps)
  const manager = caps?.serviceManager === 'launchd' ? 'launchd' : 'systemd'
  const l = langOf(lang)
  return TABLE.map((s) => {
    const [label, note] = l === 'ja' ? s.ja : s.en
    return {
      id: s.id,
      label,
      text: typeof s.text === 'function' ? s.text(svc, manager) : s.text,
      hot: Boolean(s.hot),
      run: s.run !== false,
      note,
    }
  })
}

/**
 * UI 向け一覧（`hidden` も含む・設定画面用）。
 * @param {object} [caps] Capability（既定は起動時検出）
 * @param {'en'|'ja'} [lang] 表示言語（既定 en）
 * @param {Record<string, object>} [overrides] 組み込みの上書き
 * @param {Array<object>} [custom] ユーザー定義
 * @returns {Array<object>} スニペット
 */
export function allTermSnippets(caps, lang = 'en', overrides = {}, custom = []) {
  const ov = normalizeOverrides(overrides, TERM_BUILTIN_IDS)
  const builtin = buildTermSnippets(caps, lang).map((s) => {
    const o = ov[s.id] ?? {}
    return {
      ...s,
      hot: typeof o.hot === 'boolean' ? o.hot : s.hot,
      hidden: o.hidden === true,
      custom: false,
    }
  })
  const user = normalizeCustom(custom, { withRun: true }).map((s) => ({
    id: s.id,
    label: s.label,
    text: s.text,
    hot: Boolean(s.hot),
    run: s.run !== false,
    note: s.note ?? '',
    hidden: s.hidden === true,
    custom: true,
  }))
  return [...builtin, ...user]
}

/**
 * 端末画面向け一覧（`hidden` を除く）。
 * @param {object} [caps] Capability
 * @param {'en'|'ja'} [lang] 表示言語
 * @param {Record<string, object>} [overrides] 組み込みの上書き
 * @param {Array<object>} [custom] ユーザー定義
 * @returns {Array<object>} スニペット
 */
export function listTermSnippets(caps, lang = 'en', overrides = {}, custom = []) {
  return allTermSnippets(caps, lang, overrides, custom).filter((s) => !s.hidden)
}

/** 既定 Capability・既定言語（en）で組み立てた一覧（後方互換・テスト用）。 */
export const TERM_SNIPPETS = buildTermSnippets()

/** 端末側でも「チャットの ID を上書きしない」ことを明示（テスト用）。 */
export const CHAT_BUILTIN_IDS = CHAT_IDS
