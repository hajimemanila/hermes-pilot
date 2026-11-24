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
  // 版はリリースごとに上がるので、正本（package.json）と一致することを見る
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.version, pkg.version, 'manifest.version は package.json と一致すること')
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
(tmp / "work").mkdir()
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
dedupe_check = m._dedupe_scan_dirs(["~/Projects", "~/projects"], tmp)
default_repos_scan = m.default_repos_config(tmp)["scanDirs"]
sync_file = m.sync_scan_dirs(paths, ["~/Projects", "~/work"], request=down)
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
  "dedupeCheck": dedupe_check,
  "defaultReposScan": default_repos_scan,
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
  assert.deepEqual(out.dedupeCheck, ['~/Projects'])
  assert.deepEqual(out.defaultReposScan, ['~/Projects'])
  assert.equal(out.syncFile.source, 'file', 'ブリッジ停止時はファイルへ直接書く')
  assert.deepEqual(out.syncFile.scanDirs, ['~/Projects', '~/work'])
  assert.deepEqual(out.reposPathBody.scanDirs, ['~/Projects', '~/work'])
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

test('index.js / style.css: ヘッダの EN/日本語 切替・セクションジャンプ・監査 8 件アコーディオン', () => {
  const js = read('index.js')

  // 言語: localStorage の明示選択 → config.json の ja → ブラウザ言語（SPEC V3 §3.5 / D5）
  assert.match(js, /var LANG_KEY = "hp\.dashboard\.lang"/)
  assert.match(js, /window\.localStorage\.setItem\(LANG_KEY, value\)/)
  assert.match(js, /function pickLang\(stored, configLang, browserLang\)/)
  assert.ok(js.includes('h(LangSwitch, { t: t, lang: lang, onChange: changeLang })'), 'ヘッダに切替があること')
  assert.ok(js.includes('onLangChange: changeLang'), '設定フォームの選択も即時反映すること')
  // 即時反映＋永続化は lang 単体の PUT（他フィールドはサーバ側のマージで残る）
  assert.match(js, /body: JSON\.stringify\(\{ lang: next \}\)/)
  assert.match(js, /lang: props\.langChoice \|\| "auto",/)
  assert.match(js, /langChoice: langChoice/)
  assert.ok(js.includes('{ value: "auto", label: t.langAuto }'), '設定フォームは auto / en / ja の 3 択')
  // スニペットの既定言語はヘッダの切替に追従する
  assert.match(js, /setLang\(props\.lang === "ja" \? "ja" : "en"\)/)

  // セクションショートカット: 7 枚のカード id とナビ項目が 1:1 で並ぶ
  for (const id of ['pairing', 'repos', 'settings', 'snippets', 'logs', 'service', 'links']) {
    const target = `hp-sec-${id}`
    const refs = js.match(new RegExp(`id: "${target}"`, 'g')) ?? []
    assert.ok(refs.length >= 2, `${target}: カード id とナビ項目の両方が要る（実測 ${refs.length}）`)
  }
  assert.match(js, /el\.scrollIntoView\(\{ behavior: "smooth", block: "start" \}\)/)
  assert.match(js, /prefers-reduced-motion: reduce/, 'アニメを抑制する設定では即ジャンプ')

  // 監査ログ: 最新 8 件 → 9 件目以降をアコーディオン
  assert.match(js, /var AUDIT_VISIBLE = 8/)
  assert.match(js, /auditEntries\.slice\(0, AUDIT_VISIBLE\)/)
  assert.match(js, /var auditShown = expanded \? auditEntries : auditHead/)
  assert.match(js, /t\.auditShowMore\.replace\("\{n\}", String\(auditRest\.length\)\)/)

  const css = read('style.css')
  for (const cls of ['.hp-lang', '.hp-lang-active', '.hp-nav', '.hp-nav-chip', '.hp-audit', '.hp-audit-row', '.hp-field-select']) {
    assert.ok(css.includes(cls), `${cls} のスタイルがあること`)
  }
})

test('index.js: 日本語表記「端末」→「ターミナル」に統一（SPEC V7 §3.5 / D37）', () => {
  const js = read('index.js')
  // ターミナル機能を指す日本語は「ターミナル」（英語は従来どおり Terminal）
  assert.ok(js.includes('tabTerm: "ターミナル"'), '日本語タブが「端末」のまま')
  assert.ok(
    js.includes('snippetsLead: "チャットとターミナルの定型文。Hot にすると PWA のクイックバーに出ます。"'),
    'スニペットの説明文が旧表記',
  )
  assert.ok(js.includes('tabTerm: "Terminal"'), '英語表記が壊れた')
  assert.equal(js.includes('tabTerm: "端末"'), false)
  assert.equal(js.includes('チャットと端末の定型文'), false)
})

test('pilot_dashboard.py: audit は新しい順の構造化 entries を返し、内部で redact する', () => {
  const token = '0123456789abcdef'.repeat(4)
  const script = `
import importlib.util, json, sys, tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("pd_probe5", ${JSON.stringify(path.join(DASH, 'pilot_dashboard.py'))})
m = importlib.util.module_from_spec(spec); sys.modules["pd_probe5"] = m; spec.loader.exec_module(m)

tmp = Path(tempfile.mkdtemp())
(tmp / "logs").mkdir()
token = "0123456789abcdef" * 4
(tmp / "token").write_text(token)
rows = [
    {"at": "2026-11-14T01:00:00.000Z", "kind": "auth.pairing", "target": "lan"},
    {"at": "2026-11-14T02:00:00.000Z", "kind": "repos.save", "ok": False, "path": "~/Projects/x"},
    {"at": "2026-11-14T03:00:00.000Z", "kind": "kanban.comment", "board": "mobile", "chars": 12,
     "url": "http://127.0.0.1:4097/?t=" + token},
]
raw = "\\n".join(json.dumps(r) for r in rows)
raw += "\\n" + '{"at": "2026-11-14T04:00:00.000Z", "kind": "half'
(tmp / "audit.jsonl").write_text(raw + "\\n")
paths = {"home": tmp, "hermesHome": tmp / ".hermes", "dataDir": tmp,
         "configPath": tmp / "config.json", "tokenPath": tmp / "token",
         "dashboardMetaPath": tmp / "dashboard.json",
         "auditPath": tmp / "audit.jsonl", "logDir": tmp / "logs"}

out = m.build_logs(paths, name="audit", lines=10)
plain = m.build_logs(paths, name="gateway", lines=10)
auto = m.validate_config({"lang": "auto", "scanDirs": ["~/Projects"], "servicePort": 4097},
                         home=tmp, is_dir=lambda p: True)
print(json.dumps({
  "entries": out["entries"],
  "shown": out["shown"],
  "blob": json.dumps(out),
  "plainHasEntries": "entries" in plain,
  "autoLang": auto["value"].get("lang"),
}))
`
  const out = runPython(script)
  assert.equal(out.shown, 4)
  assert.equal(out.entries.length, 4, '壊れた行も 1 行として残す')
  assert.equal(out.entries[0].at, '', '解析できない行は at 空で detail に生文字列')
  assert.match(out.entries[0].detail, /half/)
  assert.equal(out.entries[1].at, '2026-11-14T03:00:00.000Z', '新しい順（末尾が先頭）')
  assert.equal(out.entries[1].kind, 'kanban.comment')
  assert.match(out.entries[1].detail, /board=mobile/)
  assert.match(out.entries[1].detail, /<redacted>/, '構造化フィールドでもトークンを伏せる')
  assert.equal(out.entries[2].ok, false)
  assert.equal(out.entries[3].kind, 'auth.pairing')
  assert.ok(!out.blob.includes(token), '64 文字トークンは entries にも残さない')
  assert.equal(out.plainHasEntries, false, 'audit 以外は lines だけを返す')
  assert.equal(out.autoLang, 'auto', 'config.json の lang は en|ja|auto（auto = ブラウザ追従）')
})


// ---------------------------------- 5. V5-3: pipeline & architect panel

test('plugin_api.py: /pipeline の GET/POST を公開する（SPEC V5 §3.2 / D25）', () => {
  const py = read('plugin_api.py')
  assert.ok(py.includes('@router.get("/pipeline")'), 'GET /pipeline が必要')
  assert.ok(py.includes('@router.post("/pipeline")'), 'POST /pipeline が必要')
  assert.ok(py.includes('logic.build_pipeline'), 'ロジックは pilot_dashboard.py 側に置く')
  assert.ok(py.includes('logic.pipeline_action'))
})

test('index.js: パイプラインカードを登録する（ナビ・本体の両方）', () => {
  const js = read('index.js')
  assert.match(js, /id: "hp-sec-pipeline", key: "pipelineTitle"/)
  assert.match(js, /h\(PipelineSection, \{ t: t \}\)/)
  assert.match(js, /request\("\/pipeline"/)
  assert.doesNotMatch(js, /[0-9a-f]{64}/i, 'index.js に 64 文字 hex を置かない')
})

test('pilot_dashboard.py: build_pipeline が runner/適用状態/未起票を返し、トークンを漏らさない', () => {
  const script = `
import importlib.util, json, sys, tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("pd_pipe", ${JSON.stringify(path.join(DASH, 'pilot_dashboard.py'))})
m = importlib.util.module_from_spec(spec); sys.modules["pd_pipe"] = m; spec.loader.exec_module(m)

token = "0123456789abcdef" * 4
tmp = Path(tempfile.mkdtemp())
(tmp / "Projects").mkdir()
(tmp / "token").write_text(token)
(tmp / "config.json").write_text(json.dumps({"lang": "en", "scanDirs": ["~/Projects"], "servicePort": 4097}))
paths = {"home": tmp, "hermesHome": tmp / ".hermes", "dataDir": tmp,
         "configPath": tmp / "config.json", "tokenPath": tmp / "token",
         "dashboardMetaPath": tmp / "dashboard.json"}

seen = []
def fake(base, path, tok, *, method="GET", body=None, timeout=4.0):
    seen.append((path, method, body))
    if path == "/api/architect/config":
        if method == "PUT":
            return {"ok": True, "runner": body.get("runner")}
        return {"ok": True, "runner": "hermes"}
    if path == "/api/pipeline/status":
        return {"ok": True, "soul": {"applied": True, "backups": 1},
                "hermes": {"present": ["quick-review", "annotation", "spec-architect"], "missing": []},
                "antigravity": [{"id": "gemini-plugins", "available": True, "present": ["spec-architect"], "missing": []}]}
    if path.startswith("/api/architect/jobs"):
        return {"ok": True, "jobs": [{"id": "arch-1", "status": "spec_ready", "runner": "hermes",
                                      "autoStart": True, "spec": "docs/SPEC-V5.md", "createdAt": 1}],
                "pending": [{"path": "docs/SPEC-V5.md", "title": "V5", "pendingCount": 3}],
                "specReady": [{"spec": "docs/SPEC-V5.md", "title": "V5", "batchCount": 6, "launched": False}]}
    if path == "/api/pipeline/optimize":
        return {"ok": True, "soul": {"mode": "replaced", "changed": True}}
    raise AssertionError(path)

data = m.build_pipeline(paths, board="hermes-pilot", request=fake)
set_runner = m.pipeline_action(paths, {"action": "setRunner", "runner": "hermes"}, request=fake)
old_runner = m.pipeline_action(paths, {"action": "setRunner", "runner": "antigravity"}, request=fake)
bad_runner = m.pipeline_action(paths, {"action": "setRunner", "runner": "gpt"}, request=fake)
bad_action = m.pipeline_action(paths, {"action": "nope"}, request=fake)
opt = m.pipeline_action(paths, {"action": "optimize"}, request=fake)

def down(base, path, tok, *, method="GET", body=None, timeout=4.0):
    raise m.BridgeUnavailable("bridge down")

offline = m.build_pipeline(paths, request=down)
print(json.dumps({
  "runner": data["runner"], "agyKey": "hasAgyCli" in data,
  "soul": data["pipeline"]["soul"]["applied"],
  "skills": len(data["pipeline"]["hermes"]["present"]),
  "jobs": len(data["jobs"]), "pending": data["pending"][0]["pendingCount"],
  "ready": data["specReady"][0]["batchCount"],
  "boardQuery": [p for p, meth, b in seen if p.startswith("/api/architect/jobs")],
  "tokenLeak": token in json.dumps(data),
  "setRunner": set_runner.get("ok"), "setRunnerMethod": [m2 for p, m2, b in seen if p == "/api/architect/config"],
  "oldRunner": old_runner.get("code"), "badRunner": bad_runner.get("code"), "badAction": bad_action.get("code"),
  "optimizeOk": opt.get("ok"), "optimizeAction": opt.get("action"),
  "offline": [offline["source"], offline["ok"], offline["runner"]],
}))`
  const out = runPython(script)
  assert.equal(out.runner, 'hermes', 'ランナーは Hermes Native 固定')
  assert.equal(out.agyKey, false, 'hasAgyCli は /pipeline の payload から消えている')
  assert.equal(out.soul, true, 'SOUL.md の適用状態をそのまま返す')
  assert.equal(out.skills, 3)
  assert.equal(out.jobs, 1)
  assert.equal(out.pending, 3)
  assert.equal(out.ready, 6)
  assert.ok(out.boardQuery[0].includes('board=hermes-pilot'), 'ボードを渡すと jobs の絞り込みに入る')
  assert.equal(out.tokenLeak, false, '64 文字トークンは返さない')
  assert.equal(out.setRunner, true)
  assert.ok(out.setRunnerMethod.includes('PUT'), 'ランナー変更は PUT で送る')
  assert.equal(out.oldRunner, 'invalid_runner', 'hermes 以外のランナーは受け付けない')
  assert.equal(out.badRunner, 'invalid_runner')
  assert.equal(out.badAction, 'invalid_action')
  assert.equal(out.optimizeOk, true)
  assert.equal(out.optimizeAction, 'optimize')
  assert.deepEqual(out.offline, ['offline', true, 'hermes'], 'ブリッジ停止でもカードは描ける（既定 hermes）')
})

test('pilot_dashboard.py: write_config_atomic が pilotProfile を保持し、build_pipeline / setProfile がプロファイルを扱う', () => {
  const script = `
import importlib.util, json, sys, tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("pd_prof", ${JSON.stringify(path.join(DASH, 'pilot_dashboard.py'))})
m = importlib.util.module_from_spec(spec); sys.modules["pd_prof"] = m; spec.loader.exec_module(m)

tmp = Path(tempfile.mkdtemp())
cfg_path = tmp / "config.json"
cfg_path.write_text(json.dumps({"lang": "ja", "scanDirs": ["~/Projects"], "servicePort": 4097, "pilotProfile": "custom-p"}))
m.write_config_atomic(cfg_path, {"lang": "en", "scanDirs": ["~/Projects"], "servicePort": 4098})
after_cfg = json.loads(cfg_path.read_text())

(tmp / "token").write_text("tok")
paths = {"home": tmp, "hermesHome": tmp / ".hermes", "dataDir": tmp, "configPath": cfg_path, "tokenPath": tmp / "token"}
calls = []
def fake(base, path, tok, *, method="GET", body=None, timeout=4.0):
    calls.append((path, method, body))
    if path == "/api/architect/config":
        return {"ok": True, "runner": "hermes"}
    if path == "/api/pipeline/status":
        return {
            "ok": True,
            "pilotProfile": "custom-p",
            "availableProfiles": ["mobile", "custom-p", "default"],
            "profileSkills": {"profile": "custom-p", "present": ["quick-review"], "missing": []},
            "hermes": {"present": ["quick-review"], "missing": []},
            "soul": {"applied": True},
        }
    if path.startswith("/api/architect/jobs"):
        return {"ok": True, "jobs": [], "pending": [], "specReady": []}
    if path == "/api/pipeline/profile":
        return {"ok": True, "pilotProfile": (body or {}).get("profile")}
    raise AssertionError(path)

pip = m.build_pipeline(paths, request=fake)
set_prof = m.pipeline_action(paths, {"action": "setProfile", "profile": "alt-prof"}, request=fake)
print(json.dumps({
    "preservedProfile": after_cfg.get("pilotProfile"),
    "langUpdated": after_cfg.get("lang"),
    "fwdProfile": (pip.get("pipeline") or {}).get("pilotProfile"),
    "fwdAvail": (pip.get("pipeline") or {}).get("availableProfiles"),
    "fwdSkills": ((pip.get("pipeline") or {}).get("profileSkills") or {}).get("profile"),
    "setProfOk": set_prof.get("ok"),
    "setProfValue": set_prof.get("pilotProfile"),
    "profCall": [c for c in calls if c[0] == "/api/pipeline/profile"],
}))`
  const out = runPython(script)
  assert.equal(out.preservedProfile, 'custom-p')
  assert.equal(out.langUpdated, 'en')
  assert.equal(out.fwdProfile, 'custom-p')
  assert.deepEqual(out.fwdAvail, ['mobile', 'custom-p', 'default'])
  assert.equal(out.fwdSkills, 'custom-p')
  assert.equal(out.setProfOk, true)
  assert.equal(out.setProfValue, 'alt-prof')
  assert.equal(out.profCall.length, 1)
  assert.equal(out.profCall[0][1], 'POST')
})
