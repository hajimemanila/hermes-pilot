import { getCapabilities, serviceCommands } from './capabilities.js'

/**
 * 端末タブの定型コマンド。
 *
 * `run: true` のものだけ**長押しで実行**できる（タップは常に挿入のみ）。
 * 破壊的・不可逆なもの（削除系・kill 系）は載せない。
 *
 * 個人環境のサービス名は**載せない**。再起動・状態確認は
 * `capabilities.serviceManager`（launchd / systemd）で分岐する（SPEC §5.3）。
 *
 * ラベルと説明（note）は en / ja の両文面を持つ（`listTermSnippets(caps, lang)`・SPEC §6.3）。
 * コマンド文字列（text）自体は言語に依存しない。
 */

/** @typedef {{id: string, label: string, text: string, hot?: boolean, run?: boolean, note?: string}} TermSnippet */

const DRAIN = '~/.hermes/.drain_request.json'
const L = '~/.hermes/logs'

/**
 * 言語コードを `en` / `ja` に落とす（それ以外は en）。
 * @param {unknown} lang 言語
 * @returns {'en'|'ja'} 言語
 */
function langOf(lang) {
  return String(lang ?? '').trim().toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

/**
 * 端末スニペットを組み立てる。
 * @param {{serviceManager?: string, pilotServiceUnit?: string}} [caps] Capability（既定は起動時検出）
 * @param {'en'|'ja'} [lang] 表示言語（既定 en・SPEC D5）
 * @returns {TermSnippet[]} スニペット
 */
export function buildTermSnippets(caps = getCapabilities(), lang = 'en') {
  const svc = serviceCommands(caps)
  const manager = caps?.serviceManager === 'launchd' ? 'launchd' : 'systemd'
  const l = langOf(lang)
  /** en / ja を選ぶ。 */
  const t = (en, ja) => (l === 'ja' ? ja : en)
  /** @type {TermSnippet[]} */
  return [
    // --- バーに出す常用（6個）--------------------------------------------------
    {
      id: 't-gw-status',
      label: t('GW status', 'GW状態'),
      hot: true,
      run: true,
      text: 'hermes gateway status',
      note: t('Gateway status, PID and endpoints', 'gateway の稼働状況・PID・接続先'),
    },
    {
      id: 't-drain-clear',
      label: t('Clear drain', 'ドレイン解除'),
      hot: true,
      run: true,
      text: `rm -f ${DRAIN} && echo "drain marker を削除しました"`,
      note: t(
        'First move when a drain marker stalled the gateway. Removes the marker only; does not restart',
        'メンテナンス/ドレインで止まったときの第一手。マーカーを消すだけで再起動はしない',
      ),
    },
    {
      id: 't-gw-restart',
      label: t('Restart GW', 'GW再起動'),
      hot: true,
      run: true,
      text: 'hermes gateway restart',
      note: t(
        'Restart the gateway (the terminal and this PWA are separate processes and stay connected)',
        'gateway を再起動（端末とモバイルPWAは別プロセスなので切れない）',
      ),
    },
    {
      id: 't-drain-restart',
      label: t('Clear + restart', '解除+再起動'),
      hot: true,
      run: true,
      text: `rm -f ${DRAIN} && hermes gateway restart`,
      note: t(
        'Reliably bring back a gateway that is stuck on a drain marker',
        'ドレインで止まったままの gateway を確実に復帰させる',
      ),
    },
    {
      id: 't-pilot-restart',
      label: t('Restart PWA', 'PWA再起動'),
      hot: true,
      run: true,
      text: svc.restart,
      note: t(
        `Restart this app's bridge (4097) with ${manager}. The screen disconnects once`,
        `このアプリのブリッジ（4097）を ${manager} で再起動。画面は一度切れる`,
      ),
    },
    {
      id: 't-gw-log',
      label: t('GW log', 'GWログ'),
      hot: true,
      run: true,
      text: `tail -n 80 ${L}/gateway.log`,
      note: t('Last 80 lines of the gateway log', 'gateway の最新ログ 80 行'),
    },

    // --- シート（診断・その他）-------------------------------------------------
    {
      id: 't-drain-state',
      label: t('Drain state', 'ドレイン状態'),
      run: true,
      text: `ls -l ${DRAIN} 2>/dev/null || echo "drain marker なし"`,
      note: t('Check whether a drain marker is left behind', 'マーカーが残っていないか確認'),
    },
    {
      id: 't-pilot-status',
      label: t('PWA status', 'PWA状態'),
      run: true,
      text: svc.status,
      note: t(`${manager} status of this app's bridge (4097)`, `このアプリのブリッジ（4097）の ${manager} 状態`),
    },
    {
      id: 't-list',
      label: t('Service list', 'サービス一覧'),
      run: true,
      text: svc.list,
      note: t('Hermes jobs with PID and exit code', 'hermes 系ジョブと PID・終了コード'),
    },
    {
      id: 't-errors',
      label: t('Error log', 'エラーログ'),
      run: true,
      text: `tail -n 80 ${L}/errors.log`,
      note: t('Tail of errors.log', 'errors.log の末尾'),
    },
    {
      id: 't-gw-err',
      label: t('GW errors', 'GWエラー'),
      run: true,
      text: `tail -n 60 ${L}/gateway.error.log`,
      note: t('Gateway stderr', 'gateway の stderr'),
    },
    {
      id: 't-health',
      label: t('Reachability', '疎通2点'),
      run: true,
      text: 'curl -s -o /dev/null -w "dashboard %{http_code}\\\\n" http://127.0.0.1:9119/; curl -s -o /dev/null -w "mobile %{http_code}\\\\n" http://127.0.0.1:4097/healthz',
      note: t(
        'HTTP responses of the dashboard and the mobile bridge (200 means alive)',
        'ダッシュボード・モバイルの HTTP 応答（200 なら生きている）',
      ),
    },
    {
      id: 't-port',
      label: t('Ports', 'ポート確認'),
      run: true,
      text: 'lsof -nP -iTCP:9119 -sTCP:LISTEN; lsof -nP -iTCP:4097 -sTCP:LISTEN',
      note: t('9119 dashboard / 4097 mobile', '9119 ダッシュボード / 4097 モバイル'),
    },
    {
      id: 't-procs',
      label: t('Processes', 'プロセス'),
      run: true,
      text: "pgrep -fl 'hermes' | head -20",
      note: t('Hermes process list', 'hermes のプロセス一覧'),
    },
    {
      id: 't-load',
      label: t('Load', '負荷'),
      run: true,
      text: 'ps -Ao pid,pcpu,pmem,comm -r | head -8',
      note: t('Top CPU consumers', 'CPU 上位'),
    },
    {
      id: 't-disk',
      label: t('Disk', 'ディスク'),
      run: true,
      text: 'df -h ~ | tail -1',
      note: t('Free space on the home volume', 'ホームの空き'),
    },
    {
      id: 't-kanban',
      label: t('Kanban', 'カンバン状態'),
      run: true,
      text: 'hermes kanban list',
      note: t('Running and blocked tasks', '実行中・ブロック中のタスク'),
    },
    {
      id: 't-git',
      label: t('Git state', 'git状態'),
      run: true,
      text: 'git status --short && git log --oneline -3',
      note: t('Diff and recent commits of the current repo', 'カレントリポジトリの差分と直近コミット'),
    },
    {
      id: 't-hermes-ver',
      label: t('Version', '版・モデル'),
      run: true,
      text: 'hermes --version && hermes gateway status | head -5',
      note: t('Version check', 'バージョン確認'),
    },
    {
      id: 't-drain-curl',
      label: t('Drain API', 'drain API状態'),
      run: true,
      text: 'curl -s http://127.0.0.1:9119/api/actions/drain | head -3',
      note: t(
        'Drain state on the dashboard side (returns 401 when a token is required)',
        'ダッシュボード側の drain 状態（要トークンなら 401 が返る）',
      ),
    },
  ]
}

/**
 * UI 向け一覧。
 * @param {object} [caps] Capability（既定は起動時検出）
 * @param {'en'|'ja'} [lang] 表示言語（既定 en）
 * @returns {Array<object>} スニペット
 */
export function listTermSnippets(caps, lang = 'en') {
  return buildTermSnippets(caps, lang).map((s) => ({
    id: s.id,
    label: s.label,
    text: s.text,
    hot: Boolean(s.hot),
    run: s.run !== false,
    note: s.note ?? '',
  }))
}

/** 既定 Capability・既定言語（en）で組み立てた一覧（後方互換・テスト用）。 */
export const TERM_SNIPPETS = buildTermSnippets()
