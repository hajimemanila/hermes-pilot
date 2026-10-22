/**
 * 端末タブの定型コマンド。
 *
 * `run: true` のものだけ**長押しで実行**できる（タップは常に挿入のみ）。
 * 破壊的・不可逆なもの（削除系・kill 系）は載せない。再起動系は
 * 端末 PTY（ai.hermes.hermes-mobile 配下）が gateway と別プロセスなので切断されない。
 */

/** @typedef {{id: string, label: string, text: string, hot?: boolean, run?: boolean, note?: string}} TermSnippet */

const DRAIN = '~/.hermes/.drain_request.json'
const L = '~/.hermes/logs'

/** @type {TermSnippet[]} */
const TERM_SNIPPETS = [
  // --- バーに出す常用（6個）--------------------------------------------------
  {
    id: 't-gw-status',
    label: 'GW状態',
    hot: true,
    run: true,
    text: 'hermes gateway status',
    note: 'gateway の稼働状況・PID・接続先',
  },
  {
    id: 't-drain-clear',
    label: 'ドレイン解除',
    hot: true,
    run: true,
    text: `rm -f ${DRAIN} && echo "drain marker を削除しました"`,
    note: 'メンテナンス/ドレインで止まったときの第一手。マーカーを消すだけで再起動はしない',
  },
  {
    id: 't-gw-restart',
    label: 'GW再起動',
    hot: true,
    run: true,
    text: 'hermes gateway restart',
    note: 'gateway を再起動（端末とモバイルPWAは別プロセスなので切れない）',
  },
  {
    id: 't-drain-restart',
    label: '解除+再起動',
    hot: true,
    run: true,
    text: `rm -f ${DRAIN} && hermes gateway restart`,
    note: 'ドレインで止まったままの gateway を確実に復帰させる',
  },
  {
    id: 't-dash-restart',
    label: 'DASH再起動',
    hot: true,
    run: true,
    text: 'launchctl kickstart -k gui/$(id -u)/ai.hermes.dashboard',
    note: 'ダッシュボード（9119）の launchd ジョブを再起動',
  },
  {
    id: 't-gw-log',
    label: 'GWログ',
    hot: true,
    run: true,
    text: `tail -n 80 ${L}/gateway.log`,
    note: 'gateway の最新ログ 80 行',
  },

  // --- シート（診断・その他）-------------------------------------------------
  {
    id: 't-drain-state',
    label: 'ドレイン状態',
    run: true,
    text: `ls -l ${DRAIN} 2>/dev/null || echo "drain marker なし"`,
    note: 'マーカーが残っていないか確認',
  },
  {
    id: 't-list',
    label: 'launchd一覧',
    run: true,
    text: 'launchctl list | grep -i hermes',
    note: 'hermes 系ジョブと PID・終了コード',
  },
  {
    id: 't-errors',
    label: 'エラーログ',
    run: true,
    text: `tail -n 80 ${L}/errors.log`,
    note: 'errors.log の末尾',
  },
  {
    id: 't-gw-err',
    label: 'GWエラー',
    run: true,
    text: `tail -n 60 ${L}/gateway.error.log`,
    note: 'gateway の stderr',
  },
  {
    id: 't-health',
    label: '疎通3点',
    run: true,
    text: 'curl -s -o /dev/null -w "dashboard %{http_code}\\n" http://127.0.0.1:9119/; curl -s -o /dev/null -w "mobile %{http_code}\\n" http://127.0.0.1:4097/healthz; curl -s -o /dev/null -w "dsh %{http_code}\\n" http://127.0.0.1:8787/healthz',
    note: 'ダッシュボード・モバイル・DSH の HTTP 応答（200 なら生きている）',
  },
  {
    id: 't-port',
    label: 'ポート確認',
    run: true,
    text: 'lsof -nP -iTCP:9119 -sTCP:LISTEN; lsof -nP -iTCP:4097 -sTCP:LISTEN; lsof -nP -iTCP:8787 -sTCP:LISTEN',
    note: '9119 ダッシュボード / 4097 モバイル / 8787 DSH',
  },
  {
    id: 't-procs',
    label: 'プロセス',
    run: true,
    text: "pgrep -fl 'hermes|dsh' | head -20",
    note: 'hermes / dsh のプロセス一覧',
  },
  {
    id: 't-load',
    label: '負荷',
    run: true,
    text: 'ps -Ao pid,pcpu,pmem,comm -r | head -8',
    note: 'CPU 上位',
  },
  {
    id: 't-disk',
    label: 'ディスク',
    run: true,
    text: 'df -h ~ | tail -1',
    note: 'ホームの空き',
  },
  {
    id: 't-mobile-restart',
    label: 'PWA再起動',
    run: true,
    text: 'launchctl kickstart -k gui/$(id -u)/ai.hermes.hermes-mobile',
    note: 'このアプリのブリッジ（4097）を再起動。画面は一度切れる',
  },
  {
    id: 't-dsh-restart',
    label: 'DSH再起動',
    run: true,
    text: 'launchctl kickstart -k gui/$(id -u)/ai.hermes.dsh-web',
    note: 'DSH Web UI のブリッジ（8787）を再起動',
  },
  {
    id: 't-kanban',
    label: 'カンバン状態',
    run: true,
    text: 'python3 ~/.hermes/bin/kanban-sop.py status',
    note: '実行中・ブロック中のタスク',
  },
  {
    id: 't-git',
    label: 'git状態',
    run: true,
    text: 'git status --short && git log --oneline -3',
    note: 'カレントリポジトリの差分と直近コミット',
  },
  {
    id: 't-hermes-ver',
    label: '版・モデル',
    run: true,
    text: 'hermes --version && hermes gateway status | head -5',
    note: 'バージョン確認',
  },
  {
    id: 't-drain-curl',
    label: 'drain API状態',
    run: true,
    text: 'curl -s http://127.0.0.1:9119/api/actions/drain | head -3',
    note: 'ダッシュボード側の drain 状態（要トークンなら 401 が返る）',
  },
]

/** UI 向け一覧。 */
export function listTermSnippets() {
  return TERM_SNIPPETS.map((s) => ({
    id: s.id,
    label: s.label,
    text: s.text,
    hot: Boolean(s.hot),
    run: s.run !== false,
    note: s.note ?? '',
  }))
}

export { TERM_SNIPPETS }
