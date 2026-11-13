/**
 * 標準ダッシュボード用 `Hermes Pilot` タブの自動検証（T10 受入条件）。
 *
 * 3 層を確かめる:
 *  1. **契約** — `apps/dashboard/manifest.json` の必須キーと、指す先のファイルが実在すること
 *  2. **配置** — 一時 HOME で `node bin/hermes-pilot.mjs init` を 2 回走らせ、
 *     `~/.hermes/plugins/hermes-pilot/` に manifest / entry / api が揃い、壊れないこと。
 *     `--force` だけが既存ファイルを上書きすること
 *  3. **中身** — `index.js` が SDK 前提（IIFE + `window.__HERMES_PLUGIN_SDK__`）で、
 *     生の `fetch(` を使わず、トークン文字列を持たないこと。バックエンドの JSON に
 *     64 文字トークンが出ないことを python3 で実測する
 *
 * `~/.hermes/plugins` の本物は触らない（すべて一時 HOME の中）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DASHBOARD_FILES, DASHBOARD_PLUGIN } from '../../../bin/hermes-pilot.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const CLI = path.join(ROOT, 'bin', 'hermes-pilot.mjs')
const DASH = path.join(ROOT, 'apps', 'dashboard')

/** `~/.hermes/plugins/hermes-pilot/` に出来るはずのファイル（相対）。 */
const EXPECTED = [
  'plugin.yaml',
  '__init__.py',
  'dashboard/manifest.json',
  'dashboard/plugin_api.py',
  'dashboard/pilot_dashboard.py',
  'dashboard/dist/index.js',
  'dashboard/dist/style.css',
]

const read = (rel) => fs.readFileSync(path.join(DASH, rel), 'utf8')

/** 一時 HOME を作る。 */
function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-dashboard-'))
}

/** CLI を一時 HOME で実行する（開発用の上書きは落とす）。 */
function runCli(args, home) {
  const env = { ...process.env, HOME: home, HERMES_HOME: path.join(home, '.hermes') }
  delete env.HM_DATA
  delete env.HP_DATA_DIR
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 120_000 })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** python3 に小さな検証スクリプトを渡し、最後の行の JSON を返す。 */
function runPython(script) {
  const r = spawnSync(
    'python3',
    ['-c', script],
    { encoding: 'utf8', cwd: ROOT, timeout: 60_000 },
  )
  assert.equal(r.status, 0, `python3 failed: ${r.stderr ?? ''}`)
  const lines = String(r.stdout ?? '').trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

// ---------------------------------------------------------------- 1. contract

test('manifest: label / icon / tab / entry / css / api が揃い、指す先が実在する', () => {
  const manifest = JSON.parse(read('manifest.json'))
  assert.equal(manifest.name, DASHBOARD_PLUGIN)
  assert.equal(manifest.label, 'Hermes Pilot')
  assert.equal(manifest.icon, 'QrCode')
  assert.equal(manifest.version, '0.1.0')
  assert.ok(manifest.description && manifest.description.length > 20, 'description は説明文であること')
  assert.deepEqual(manifest.tab, { path: '/hermes-pilot', position: 'after:git-ops' })
  assert.equal(manifest.entry, 'dist/index.js')
  assert.equal(manifest.css, 'dist/style.css')
  assert.equal(manifest.api, 'plugin_api.py')

  // リポジトリでは dist/ を切らず、`init` が dist/ 形へ写す。写し元の対応を確かめる。
  const sourceFor = Object.fromEntries(DASHBOARD_FILES.map((f) => [f.to, f.from]))
  for (const key of ['entry', 'css', 'api']) {
    const target = `dashboard/${manifest[key]}`
    const source = sourceFor[target]
    assert.ok(source, `${key} の写し元が DASHBOARD_FILES にあること: ${target}`)
    assert.ok(fs.existsSync(path.join(ROOT, source)), `写し元が実在すること: ${source}`)
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'plugin.yaml')), 'plugin.yaml がルートにあること')
})

test('plugin.yaml: name / description / requires_hermes を持つ', () => {
  const yaml = fs.readFileSync(path.join(ROOT, 'plugin.yaml'), 'utf8')
  assert.match(yaml, /^name: hermes-pilot$/m)
  assert.match(yaml, /^version: \d+\.\d+\.\d+$/m)
  assert.match(yaml, /^description: .{20,}$/m)
  assert.match(yaml, /^requires_hermes: ">=0\.23\.0"$/m)
})

test('plugin_init.py: 有効化できる no-op プラグイン（`register(ctx)`）である', () => {
  const py = read('plugin_init.py')
  assert.match(py, /^def register\(ctx\)/m)
  const importLines = py.split('\n').filter((line) => /^\s*(import|from)\s/.test(line))
  assert.ok(
    importLines.every((line) => line.includes('__future__')),
    `エージェント側の面を作らない（import は __future__ だけ）: ${importLines.join(' / ')}`,
  )
  // インストール後はパッケージ初期化ファイルになる（`hermes plugins enable` の解決先）
  const mapping = Object.fromEntries(DASHBOARD_FILES.map((f) => [f.to, f.from]))
  assert.equal(mapping['__init__.py'], 'apps/dashboard/plugin_init.py')
})

// ------------------------------------------------------------------- 2. files

test('index.js: IIFE が SDK の React と authenticated fetch だけを使う', () => {
  const js = read('index.js')
  assert.match(js, /\(function \(\) \{/)
  assert.match(js, /window\.__HERMES_PLUGIN_SDK__/)
  assert.match(js, /window\.__HERMES_PLUGINS__\.register\("hermes-pilot", App\)/)
  assert.match(js, /SDK\.authedFetch/)
  // トークンを自分で読まない・生 fetch を叩かない（auth はホスト SDK の責務）
  assert.doesNotMatch(js, /[^.\w]fetch\(/, '生の fetch( は使わない')
  assert.doesNotMatch(js, /__HERMES_SESSION_TOKEN__/)
  assert.doesNotMatch(js, /[0-9a-f]{64}/i, 'index.js に 64 文字 hex を置かない')
  // 出力先はこのプラグインの名前空間だけ
  assert.match(js, /var API = "\/api\/plugins\/hermes-pilot"/)
  assert.doesNotMatch(js, /\/api\/plugins\/(?!hermes-pilot)/)
})

test('index.js: QR は 1:1（287px）で <img> 表示する', () => {
  const js = read('index.js')
  assert.match(js, /var QR_SIZE = 287/)
  assert.match(js, /src: data\.qrPng/)
})

test('style.css: クラスは hp- 接頭辞で、色は --color-* トークンから取る', () => {
  const css = read('style.css')
  const classes = new Set((css.match(/\.hp-[a-z0-9-]+/g) ?? []).map((c) => c.slice(1)))
  assert.ok(classes.size >= 20, `hp- クラスが十分にあること（実測 ${classes.size}）`)
  assert.ok(css.includes('--color-card'), 'ホストの --color-* トークンを使うこと')
  assert.ok(css.includes('image-rendering: pixelated'), 'QR をぼかさないこと')
})

test('pilot_dashboard.py: 返す JSON にトークン（64 文字 hex）が混ざらない', () => {
  const script = `
import importlib.util, json, sys, tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("pd_probe", ${JSON.stringify(path.join(DASH, 'pilot_dashboard.py'))})
m = importlib.util.module_from_spec(spec); sys.modules["pd_probe"] = m; spec.loader.exec_module(m)

token = "0123456789abcdef" * 4  # 64 文字・ダミー
tmp = Path(tempfile.mkdtemp())
(tmp / "Projects").mkdir()
(tmp / "token").write_text(token)
(tmp / "config.json").write_text(json.dumps({"lang": "en", "scanDirs": ["~/Projects"], "servicePort": 4097, "tlsPort": 8444, "tailscaleDns": "box.tailnet.ts.net"}))
paths = {"home": tmp, "hermesHome": tmp / ".hermes", "dataDir": tmp,
         "configPath": tmp / "config.json", "tokenPath": tmp / "token",
         "dashboardMetaPath": tmp / "dashboard.json"}

def fake_get(base, path, tok):
    if path == "/api/me":
        return {"ok": True, "version": "0.1.0", "token": tok}
    if path == "/api/capabilities":
        return {"os": "darwin", "serviceManager": "launchd", "hasTailscale": True,
                "hasHermesCli": True, "pilotServiceUnit": "ai.hermes.pilot"}
    if path == "/api/auth/pairing":
        return {"ok": True, "qrPng": "data:image/png;base64,AAAA",
                "targets": [{"label": "LAN", "url": "http://10.0.0.2:4097/#t=deadbeef"}],
                "expiresAt": 1760000000000, "port": 4097, "tlsPort": 8444, "token": tok}
    raise AssertionError(path)

status = m.build_status(paths, get=fake_get,
                        service=lambda: {"manager": "launchd", "unit": "ai.hermes.pilot", "state": "running"},
                        ip_lookup=lambda: "10.0.0.2")
pairing = m.build_pairing(paths, get=fake_get)
config = m.read_config(paths["configPath"])
blob = json.dumps([status, pairing, config])
bad = m.validate_config({"scanDirs": ["~/nope"], "tlsPort": "0", "servicePort": "70000", "tailscaleDns": "no host"},
                        home=tmp)
good = m.validate_config({"lang": "ja", "scanDirs": ["~/Projects"], "tlsPort": "", "servicePort": 4097,
                          "tailscaleDns": "box.tailnet.ts.net"}, home=tmp)
home_dir = m.validate_config({"scanDirs": ["~"], "servicePort": 4097}, home=tmp)
svc = m.service_status(platform="linux", run=lambda argv: (0, "active"))
print(json.dumps({
  "tokenInPayload": token in blob,
  "statusKeys": sorted(status.keys()),
  "pairingKeys": sorted(pairing.keys()),
  "bridge": status["bridge"],
  "lanUrl": status["lanUrl"],
  "tailscaleUrl": status["tailscaleUrl"],
  "qrIsPng": pairing["qrPng"].startswith("data:image/png;base64,"),
  "expiresAt": pairing["expiresAt"],
  "badErrors": bad["errors"],
  "goodValue": good["value"],
  "homeError": home_dir["errors"].get("scanDirs"),
  "svc": svc,
}))
`
  const out = runPython(script)
  assert.equal(out.tokenInPayload, false, 'トークンが JSON に含まれてはいけない')
  assert.deepEqual(out.statusKeys, [
    'bridge',
    'capabilities',
    'dataDir',
    'lanUrl',
    'ok',
    'port',
    'service',
    'tailscaleUrl',
  ])
  assert.deepEqual(out.pairingKeys, ['expiresAt', 'ok', 'port', 'qrPng', 'tailscale', 'targets', 'tlsPort'])
  assert.deepEqual(out.bridge, { reachable: true, version: '0.1.0' })
  assert.equal(out.lanUrl, 'http://10.0.0.2:4097/')
  assert.equal(out.tailscaleUrl, 'https://box.tailnet.ts.net:8444/')
  assert.equal(out.qrIsPng, true)
  assert.equal(out.expiresAt, 1760000000000)
  assert.equal(out.badErrors.scanDirs, 'not_a_directory')
  assert.equal(out.badErrors.tlsPort, 'out_of_range')
  assert.equal(out.badErrors.servicePort, 'out_of_range')
  assert.equal(out.badErrors.tailscaleDns, 'invalid_hostname')
  assert.deepEqual(out.goodValue, {
    lang: 'ja',
    scanDirs: ['~/Projects'],
    tlsPort: null,
    servicePort: 4097,
    tailscaleDns: 'box.tailnet.ts.net',
  })
  assert.equal(out.homeError, 'home_directory', 'ホーム直下そのものはスキャン対象にしない')
  assert.deepEqual(out.svc, { manager: 'systemd', unit: 'hermes-pilot.service', state: 'running' })
})

test('pilot_dashboard.py: config の書き込みは tmp→rename のアトミック・0600', () => {
  const script = `
import importlib.util, json, os, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("pd_probe2", ${JSON.stringify(path.join(DASH, 'pilot_dashboard.py'))})
m = importlib.util.module_from_spec(spec); sys.modules["pd_probe2"] = m; spec.loader.exec_module(m)
tmp = Path(tempfile.mkdtemp())
target = tmp / "config.json"
m.write_config_atomic(target, {"lang": "en", "scanDirs": ["~/Projects"], "tlsPort": 8444,
                               "tailscaleDns": "box.tailnet.ts.net", "servicePort": 4097})
leftovers = [p.name for p in tmp.iterdir() if p.name != "config.json"]
print(json.dumps({
  "mode": oct(os.stat(target).st_mode & 0o777),
  "body": json.loads(target.read_text()),
  "leftovers": leftovers,
}))
`
  const out = runPython(script)
  assert.equal(out.mode, '0o600')
  assert.equal(out.body.servicePort, 4097)
  assert.equal(out.body.tlsPort, 8444)
  assert.deepEqual(out.leftovers, [], '一時ファイルを残さない')
})

test('python ファイル: python3 -m py_compile が exit 0', () => {
  const r = spawnSync(
    'python3',
    ['-m', 'py_compile', 'apps/dashboard/plugin_api.py', 'apps/dashboard/pilot_dashboard.py', 'apps/dashboard/plugin_init.py'],
    { encoding: 'utf8', cwd: ROOT, timeout: 60_000 },
  )
  assert.equal(r.status, 0, r.stderr ?? '')
})

test('plugin_api.py: router を公開し、5 本のルートを /api/plugins/hermes-pilot 配下に置く', () => {
  const py = read('plugin_api.py')
  assert.match(py, /^router = APIRouter\(\)$/m)
  for (const route of ['@router.get("/status")', '@router.get("/pairing")', '@router.get("/config")', '@router.put("/config")', '@router.post("/service/{action}")']) {
    assert.ok(py.includes(route), `${route} が必要`)
  }
  // prefix はホストが付ける（このファイルに焼き込まない）
  assert.doesNotMatch(py, /APIRouter\(prefix=/)
  assert.doesNotMatch(py, /[0-9a-f]{64}/i)
})

// -------------------------------------------------------------- 3. install

test('init: 一時 HOME に dashboard 一式を配置し、2 回目でも壊れない', () => {
  const home = tempHome()
  const first = runCli(['init'], home)
  assert.equal(first.status, 0, first.out)
  const root = path.join(home, '.hermes', 'plugins', DASHBOARD_PLUGIN)
  for (const rel of EXPECTED) {
    assert.ok(fs.existsSync(path.join(root, rel)), `init 後にあること: ${rel}`)
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dashboard', 'manifest.json'), 'utf8'))
  assert.equal(manifest.label, 'Hermes Pilot')
  assert.equal(manifest.entry, 'dist/index.js')
  assert.ok(fs.statSync(path.join(root, 'dashboard', 'dist', 'index.js')).size > 1000)

  // 手を入れたファイルは 2 回目の init で消えない（冪等・上書きしない）
  const stylePath = path.join(root, 'dashboard', 'dist', 'style.css')
  fs.writeFileSync(stylePath, '/* local tweak */\n')
  const second = runCli(['init'], home)
  assert.equal(second.status, 0, second.out)
  assert.equal(fs.readFileSync(stylePath, 'utf8'), '/* local tweak */\n')

  // --force だけが上書きする
  const forced = runCli(['init', '--force'], home)
  assert.equal(forced.status, 0, forced.out)
  assert.match(fs.readFileSync(stylePath, 'utf8'), /\.hp-root/)
})

test('init: dashboard.json に CLI の絶対パスを記録する（サービス操作の手掛かり）', () => {
  const home = tempHome()
  const r = runCli(['init'], home)
  assert.equal(r.status, 0, r.out)
  const metaPath = path.join(home, '.hermes', 'plugin-data', 'hermes-pilot', 'dashboard.json')
  assert.ok(fs.existsSync(metaPath), 'dashboard.json があること')
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  assert.equal(meta.plugin, 'hermes-pilot')
  assert.equal(meta.cli, path.join(ROOT, 'bin', 'hermes-pilot.mjs'))
  assert.ok(fs.existsSync(meta.cli))
  assert.equal(fs.statSync(metaPath).mode & 0o777, 0o600)
})

// ------------------------------------------- 4. P4: repos / snippets / logs

test('plugin_api.py: /repos・/snippets・/logs のルートを持つ（scanDirs 同期・秘匿）', () => {
  const py = read('plugin_api.py')
  for (const route of [
    '@router.get("/repos")',
    '@router.post("/repos")',
    '@router.get("/snippets")',
    '@router.put("/snippets")',
    '@router.get("/logs")',
  ]) {
    assert.ok(py.includes(route), `${route} が必要`)
  }
  assert.match(py, /alias="file"/, '`file` クエリは alias で受ける')
  assert.match(py, /pattern="\^\(gateway\|errors\|pilot\|audit\)\$"/, 'ログ名はホワイトリスト')
  assert.match(py, /logic\.sync_scan_dirs\(/, 'PUT /config が scanDirs を同期する')
  assert.doesNotMatch(py, /[0-9a-f]{64}/i, '64 文字 hex を置かない')
})

test('index.js / style.css: Repositories・Snippets・Logs のカードを持つ', () => {
  const js = read('index.js')
  for (const section of ['RepositoriesSection', 'SnippetsSection', 'LogsSection']) {
    assert.ok(js.includes(`function ${section}`), `${section} があること`)
    assert.ok(js.includes(`h(${section},`), `${section} が App に載っていること`)
  }
  assert.match(js, /var LOG_FILES = \["gateway", "errors", "pilot", "audit"\]/)
  assert.match(js, /request\("\/repos"\)/)
  assert.match(js, /\/snippets\?kind=" \+ kind \+ "&lang=" \+ lang/)
  assert.match(js, /\/logs\?file=" \+ name \+ "&lines=" \+ lines/)
  assert.doesNotMatch(js, /[.\w]fetch\(/, '生の fetch( は使わない')

  const css = read('style.css')
  for (const cls of ['.hp-repo', '.hp-tab', '.hp-toggle', '.hp-log', '.hp-snippet']) {
    assert.ok(css.includes(cls), `${cls} のスタイルがあること`)
  }
})

test('pilot_dashboard.py: scanDirs を repos.json へ同期し、repos/*/snippets/logs を返す（トークン非混入）', () => {
  const script = `
import importlib.util, json, os, sys, tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("pd_probe4", ${JSON.stringify(path.join(DASH, 'pilot_dashboard.py'))})
m = importlib.util.module_from_spec(spec); sys.modules["pd_probe4"] = m; spec.loader.exec_module(m)

tmp = Path(tempfile.mkdtemp())
(tmp / "Projects" / "alpha" / ".git").mkdir(parents=True)
(tmp / "Projects" / "beta" / ".git").mkdir(parents=True)
(tmp / "logs").mkdir()
token = "0123456789abcdef" * 4
(tmp / "token").write_text(token)
(tmp / "config.json").write_text(json.dumps({"lang": "en", "scanDirs": ["~/Projects"], "servicePort": 4097}))
paths = {"home": tmp, "hermesHome": tmp / ".hermes", "dataDir": tmp,
         "configPath": tmp / "config.json", "tokenPath": tmp / "token",
         "dashboardMetaPath": tmp / "dashboard.json", "reposPath": tmp / "repos.json",
         "snippetsPath": tmp / "snippets.json", "termSnippetsPath": tmp / "term-snippets.json",
         "auditPath": tmp / "audit.jsonl", "logDir": tmp / "logs"}

def down(*a, **k):
    raise m.BridgeUnavailable("bridge down")

calls = []
def bridge(base, path, tok, **kw):
    calls.append({"path": path, "method": kw.get("method", "GET"), "body": kw.get("body")})
    method = kw.get("method", "GET")
    if path == "/api/repos" and method == "POST":
        return {"ok": True, "scanDirs": (kw.get("body") or {}).get("scanDirs")}
    if path == "/api/repos" and method == "GET":
        return {"repos": [{"id": "alpha", "label": "alpha", "path": str(tmp / "Projects" / "alpha"),
                           "source": "scan", "pinned": False, "boards": []}],
                "scanDirs": ["~/Projects"]}
    if path.startswith("/api/snippets"):
        return {"snippets": [], "allSnippets": [{"id": "review", "label": "Bug Review", "text": "x",
                                                 "hot": True, "hidden": False, "custom": False}],
                "overrides": {"review": {"hidden": True}},
                "custom": [{"id": "c-1", "label": "L", "text": "T", "hot": False, "custom": True}],
                "customMax": 16, "hotLimit": 8}
    if path == "/api/repos/scan":
        return {"ok": True, "repos": [], "scanDirs": []}
    raise AssertionError(path)

cfg_before = m.build_config(paths)
sync_file = m.sync_scan_dirs(paths, ["~/Projects", "~/projects"], request=down)
repos_path_body = json.loads((tmp / "repos.json").read_text())
repos_file = m.build_repos(paths, request=down)
pin = m.repos_action(paths, {"action": "pin", "id": "alpha"}, request=down)
hidden = m.repos_action(paths, {"action": "hide", "id": "beta"}, request=down)
unhide = m.repos_action(paths, {"action": "unhide", "id": "beta"}, request=down)
add_bad = m.repos_action(paths, {"action": "add", "path": str(tmp / "logs")}, request=down)
bad_action = m.repos_action(paths, {"action": "nope"}, request=down)

sync_bridge = m.sync_scan_dirs(paths, ["~/Projects"], request=bridge)
repos_bridge = m.build_repos(paths, request=bridge)
snippets = m.build_snippets(paths, "chat", "ja", request=bridge)
term_saved = m.save_snippets(paths, "term", "en",
                             {"custom": [{"label": "端末", "text": "ls -la", "run": False}],
                              "overrides": {"uptime": {"hot": True}}}, request=down)
chat_reset = m.save_snippets(paths, "chat", "en", {"reset": True}, request=down)

(tmp / "logs" / "gateway.log").write_text("boot\\nGET /api/me?t=%s\\npair http://127.0.0.1:4097/?token=E8Z3CP4H\\n" % token)
logs = m.build_logs(paths, "gateway", 50)
audit = m.build_logs(paths, "audit", 5)

try:
    m.build_logs(paths, "../../etc/passwd", 5)
    traversal = False
except ValueError:
    traversal = True

blob = json.dumps([sync_file, repos_file, pin, hidden, unhide, snippets, term_saved, chat_reset,
                   logs, audit, m.build_config(paths)])
print(json.dumps({
  "configSourceBefore": cfg_before["scanDirsSource"],
  "configSourceAfter": m.build_config(paths)["scanDirsSource"],
  "syncFile": sync_file,
  "reposPathBody": repos_path_body,
  "reposFileSource": repos_file["source"],
  "reposFileIds": [r["id"] for r in repos_file["repos"]],
  "reposFileHidden": repos_file["config"]["hidden"],
  "pinPinned": [r["pinned"] for r in pin["repos"]],
  "afterHide": [r["id"] for r in hidden["repos"]],
  "afterUnhide": [r["id"] for r in unhide["repos"]],
  "addBadCode": add_bad.get("code"),
  "badActionCode": bad_action.get("code"),
  "syncBridgeSource": sync_bridge["source"],
  "bridgeCalls": calls,
  "reposBridgeSource": repos_bridge["source"],
  "snippets": {"source": snippets["source"], "all": len(snippets["allSnippets"]),
               "overrides": snippets["overrides"], "custom": len(snippets["custom"])},
  "termStore": json.loads((tmp / "term-snippets.json").read_text()),
  "chatStore": json.loads((tmp / "snippets.json").read_text()),
  "logs": {"shown": logs["shown"], "lines": logs["lines"], "missing": logs["missing"]},
  "auditMissing": audit["missing"],
  "traversalRejected": traversal,
  "tokenInBlob": token in blob,
  "mode": oct(os.stat(tmp / "repos.json").st_mode & 0o777),
  "leftovers": [p.name for p in tmp.iterdir() if p.name.startswith(".")],
}))
`
  const out = runPython(script)

  // G3: repos.json が scanDirs の正になる
  assert.equal(out.configSourceBefore, 'config.json', 'repos.json が無いうちは config.json')
  assert.equal(out.configSourceAfter, 'repos.json')
  assert.equal(out.syncFile.source, 'file', 'ブリッジ停止時はファイルへ直接書く')
  assert.deepEqual(out.syncFile.scanDirs, ['~/Projects', '~/projects'])
  assert.deepEqual(out.reposPathBody.scanDirs, ['~/Projects', '~/projects'])
  assert.equal(out.mode, '0o600')
  assert.deepEqual(out.leftovers, [])

  // リポジトリ操作（ブリッジ停止時はファイル）
  assert.equal(out.reposFileSource, 'file')
  assert.deepEqual(out.reposFileIds, ['alpha', 'beta'])
  assert.deepEqual(out.pinPinned, [true, false])
  assert.deepEqual(out.afterHide, ['alpha'])
  assert.deepEqual(out.afterUnhide, ['alpha', 'beta'])
  assert.equal(out.addBadCode, 'not_git_repo')
  assert.equal(out.badActionCode, 'invalid_action')
  assert.deepEqual(out.reposFileHidden, out.reposPathBody.hidden)

  // ブリッジ経由の同期は source:"bridge" で、POST が飛ぶ
  assert.equal(out.syncBridgeSource, 'bridge')
  assert.ok(
    out.bridgeCalls.some((c) => c.path === '/api/repos' && c.method === 'POST'),
    'ブリッジ /api/repos へ POST すること',
  )
  assert.equal(out.reposBridgeSource, 'bridge')

  // スニペット
  assert.equal(out.snippets.source, 'bridge')
  assert.equal(out.snippets.all, 1)
  assert.deepEqual(out.snippets.overrides, { review: { hidden: true } })
  assert.equal(out.termStore.version, 2)
  assert.deepEqual(out.termStore.overrides, { uptime: { hot: true } })
  assert.equal(out.termStore.custom[0].text, 'ls -la')
  assert.equal(out.termStore.custom[0].run, false)
  assert.match(out.termStore.custom[0].id, /^c-/)
  assert.deepEqual(out.chatStore, { version: 2, overrides: {}, custom: [] })

  // ログ: トークンは必ず伏せる
  assert.equal(out.logs.shown, 3)
  assert.ok(out.logs.lines.some((l) => l.includes('<redacted>')), 'トークンを伏せること')
  assert.ok(
    out.logs.lines.some((l) => l.includes('token=<redacted>')),
    'ペアリングコードもクエリごと伏せること',
  )
  assert.ok(!out.logs.lines.some((l) => l.includes('E8Z3CP4H')), 'ペアリングコードを残さない')
  const rawLog = JSON.stringify(out.logs)
  assert.ok(!rawLog.includes('E8Z3CP4H'), '生のコードが混ざらない')
  assert.equal(out.auditMissing, true, '無いログは missing:true')
  assert.equal(out.traversalRejected, true)
  assert.equal(out.tokenInBlob, false, 'どのレスポンスにも 64 文字トークンが入らない')
})

