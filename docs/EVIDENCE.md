# EVIDENCE — Hermes モバイル PWA（計画時点の実測）

計測日: 2026-10-22 / ホスト: M4 Mac mini（macOS 27.0.1, 16GB）/ Hermes 0.22.4 (2026.9.24, commit 4d04303)

## 1. サーバの正体

```
$ hermes serve --help
Run the Hermes backend server — the JSON-RPC/WebSocket gateway the desktop app
and remote clients connect to. Headless: it never opens a browser UI.
  --port PORT   Port (default 9119, 0 for auto-assign)
  --host HOST   Host (default 127.0.0.1)
  --insecure    DEPRECATED / NO-OP … Bind 127.0.0.1 + tunnel to keep it local.

$ hermes dashboard --help   # 同サーバ + Web UI
```

```
$ lsof -nP -iTCP:9119 -sTCP:LISTEN
python3.1 68539 hajimenakagawa 10u IPv4 TCP 127.0.0.1:9119 (LISTEN)
```

→ 9119 はループバックのみ。PWA は直接叩けない（CORS と Origin ゲート）。

## 2. 認証

```
$ curl -s http://127.0.0.1:9119/ | grep -o 'window.__HERMES_SESSION_TOKEN__="[^"]*"'
window.__HERMES_SESSION_TOKEN__="54J7_bnnEmtMECaZHPE2s1aQuXF4dcnDnPJCEgsaMbM"
```

`hermes_cli/web_server.py`:

```python
def _resolve_session_token() -> str:
    return os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN") or secrets.token_urlsafe(32)
```

launchd `ai.hermes.dashboard` の plist に `HERMES_DASHBOARD_SESSION_TOKEN` は**無い**
→ トークンは起動ごとの乱数。ブリッジは HTML から拾うか、env を固定する必要がある。

WS の認証（`hermes_cli/web_server_chat.py`）:

```
Loopback / --insecure: legacy ?token= (constant-time compared)
Gated: ?ticket= (browser-minted, single-use, 30s TTL) or ?internal=
```

→ 127.0.0.1 から接続するブリッジは `?token=` を使える。

## 3. 使える API（認証済みで叩いた結果）

```
200 /api/health          {"ok":true,"version":"0.22.4",...}
200 /api/status          {"version":"0.22.4","config_version":51,...}
200 /api/system/stats    {"os":"Darwin","cpu_count":10,"memory":{"total":17179869184,"used":8019509248,"percent":62.6},"disk":{...}}
200 /api/sessions        {"sessions":[{"id":"20261022_163552_3305cfe1","source":"discord","is_active":true,
                                        "last_activity_description":"starting new turn","message_count":404,
                                        "tool_call_count":225,"estimated_cost_usd":0.685,...}]}
200 /api/sessions/{id}   セッション詳細（同上のフル項目）
200 /api/config          {"model":"deepseek-flash","providers":{...}}
200 /api/cron/jobs       [{"id":"7cad0b034fff","name":"kanban-reap",...}]
200 /api/ops/hooks       {"hooks":[{"event":"pre_tool_call","matcher":"terminal|execute_code",
                                    "command":"…/nogui-guard.py",...}]}
200 /api/tools/toolsets  [{"name":"web","label":"Web Search & Scraping",...}]
200 /api/plugins/system-ops/blocked-processes
                         {"ok":true,"generated_at":"2026-10-22T23:33:25+08:00","data":{"ok":true,...}}
404 /api/models          → モデル一覧は /api/config と /api/tools/toolsets/{name}/models から
404 /api/kanban/tasks     → カンバンは HTTP API を持たない（後述）
```

## 4. 制御系 API（実測・副作用あり）

```
$ curl -X POST -H "X-Hermes-Session-Token: $TOK" .../api/gateway/drain
{"ok":true,"action":"drain","requested_at":"2026-10-22T15:34:39.425300+00:00","draining":true,...}

$ curl -X POST -H "X-Hermes-Session-Token: $TOK" .../api/gateway/restart
{"ok":true,"pid":96963,"name":"gateway-restart"}
```

gateway.log（同じ瞬間）:

```
23:34:40 INFO gateway.run: SIGUSR1 received (systemctl reload / hermes gateway restart):
                       performing a graceful gateway restart — drain active turns, exit,
                       supervisor relaunches. Not an in-process config reload.
23:34:40 INFO gateway.run: Restart requested with 1 active work unit(s); deferring stop()
                       until they finish (cap=1800s) so in-flight turns are not amputated
23:34:40 INFO gateway.run: Restart deferred: waiting on 1 active work unit(s) …
23:34:40 INFO gateway.run: External drain ENGAGED (.drain_request.json present) —
                       refusing new turns; 1 in-flight turn(s) will finish. Process stays up.
```

→ **キルスイッチの挙動が実測できた**。drain は新規受付を止めてターンは完走、restart は
SIGUSR1 でターン完了を待ってから（最大 1800 秒）再起動。単発の 1 タップで即断しない設計が必要。

## 5. WebSocket

```
$ grep -n "@router.websocket" hermes_cli/web_routers/*.py
/api/console   /api/pty   /api/ws   /api/pub   /api/events   /api/display/ws   /api/audio/*
```

`/api/ws` → `tui_gateway.ws.handle_ws`（JSON-RPC 2.0）。通知名:

```
gateway.ready / gateway.ping / message.delta / reasoning.delta / thinking.delta
session.context_breakdown
```

→ チャットは REST ではなく WS。実装時は探針テストで固定する（DSH の `probe-sdk.mjs` と同手法）。

## 6. カンバン

```
$ sqlite3 ~/.hermes/kanban.db ".tables"
kanban_notify_subs  task_comments  task_links  tasks  task_attachments  task_events  task_runs

$ ls ~/.hermes/kanban/boards
deepseek-hermes  dsh-web-ui  git-ops  kanban-sop  nanokvm-custom-launcher  nanokvm-dev-env  roi-costs  system-ops

$ cat ~/.hermes/kanban/boards/dsh-web-ui/board.json
{"slug":"dsh-web-ui","name":"DSH Web UI (Android)","icon":"📱",
 "default_workdir":"/Users/hajimenakagawa/Projects/dsh-web-ui","archived":false}

$ sqlite3 ~/.hermes/kanban/boards/dsh-web-ui/kanban.db "pragma table_info(tasks)" | head
id|title|body|assignee|status|priority|created_by|created_at|started_at|completed_at|…
```

→ ボードごとに独立した SQLite。**read-only で読む**のが最短（HTTP API は存在しない）。
`task_runs` に実行履歴、`task_events` に時系列（ログストリームの代替）がある。

## 7. セッションの状態

```
$ sqlite3 ~/.hermes/state.db ".tables"   # 69 セッション
sessions  messages  messages_fts  …  session_model_usage  worker_executions

$ sqlite3 ~/.hermes/state.db "pragma table_info(messages)"
id|session_id|role|content|tool_call_id|tool_calls|tool_name|effect_disposition|…
```

→ チャット履歴は `state.db` からも読める（WS が落ちたときの退避経路）。
