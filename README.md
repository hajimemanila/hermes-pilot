# Hermes Pilot

Drive an autonomous [Hermes Agent](https://hermes-agent.nousresearch.com/docs) from your phone or tablet.
**Hermes Pilot** turns the decisions an agent needs into one-tap review sheets and annotated screenshots,
and puts kanban, chat, terminal and usage into a single installable PWA.

日本語版は [`README.ja.md`](README.ja.md)。

```text
[phone / tablet PWA] → https://<tailscale-host>/ (or http://<lan-ip>:4097)
                              │
                        [bridge :4097] ──► http://127.0.0.1:9119  (the existing Hermes dashboard, untouched)
                              ├── kanban SQLite (read-only)
                              ├── Hermes WebSocket (chat JSON-RPC relay)
                              └── ~/.hermes/plugin-data/hermes-pilot/  (token, review sheets, shots, feed)
```

## What you get

- **Quick Review** — the agent writes a sheet of 3 (±1) questions with a recommended option, opens it as a
  blocked kanban task, and you answer with one tap. The answer comes back as a comment and the worker is
  unblocked. Skill: `skills/quick-review/`.
- **Annotation** — the agent attaches a screenshot; you draw on it with a finger (rectangles, arrows, notes)
  and send back an ordered, coordinate-tagged fix list. Skill: `skills/annotation/`.
- **Tasks / Inbox** — boards, task detail, event history, per-task git diff, approve / comment / abort.
- **Chat** — streaming Hermes chat with thinking log, tool log, attachments, snippets, cross-session search.
- **Terminal** — a real PTY over the bridge, with command snippets that follow your OS.
- **English and Japanese** (`en` is the fallback, `ja` is bundled), **Dark / Light / System** themes and a
  **two-pane tablet layout** at ≥ 820 px.
- **No external plugins required** — repositories are found by scanning your project folders, and system
  status uses only the standard Hermes APIs.

### Decision cockpit (v2)

Five additions that shorten the loop from "the agent needs a decision" to "it is running again".
Every one of them is reachable from the phone and from the standard dashboard.

- **Spec Launchpad** — the Tasks tab reads `docs/SPEC-*.md` of the board's repository, lists the batches the
  spec defines (`### Batch P1: …`) and files them as kanban tasks with one tap. A batch whose `[ID]` task is
  still open is skipped, so double-taps and reloads never pile up duplicates.

  ```bash
  curl -s -H "x-client: mobile" "http://127.0.0.1:4097/api/specs?board=<board>&t=$(cat ~/.hermes/plugin-data/hermes-pilot/token)"
  curl -s -X POST -H "x-client: mobile" -H "content-type: application/json" \
       -d '{"board":"<board>","specRelPath":"docs/SPEC-PILOT-V2.md","batchIds":["P5"]}' \
       "http://127.0.0.1:4097/api/specs/launch?t=$(cat ~/.hermes/plugin-data/hermes-pilot/token)"
  ```

- **1-Tap Fast-Track** — when a review sheet's questions carry recommended options, the pane shows
  *⚡ Accept All Recommended (Q1:A · Q2:B) & Resume*: one tap sends every recommended answer, unblocks the
  worker and jumps to the next waiting sheet (`POST /api/review/:id/answer`).

- **Before ↔ After** — an annotation review that has a previous round (`*.before.png` or the previous
  numbered shot) gets a compare toggle, so you can flip between the red pen you drew and the latest
  screenshot; *✅ Looks Good* closes the task in one tap (`POST /api/review/:id/approve`).

- **Standard dashboard integration** — the *Hermes Pilot* tab of the Hermes dashboard (`:9119`) manages
  repositories (add / pin / hide / create board), chat & terminal snippets, and the bridge / gateway / audit
  logs against the same files the PWA uses, so `scanDirs` is configured in exactly one place.

  ```bash
  npx hermes-pilot init --force      # refresh the dashboard plugin files after an upgrade
  ```

- **Snippet editing** — built-in snippets can be pinned to the chip bar (Hot) or hidden, and you can add,
  edit, reorder and delete your own, for chat and terminal, in English and Japanese, with
  *Reset to defaults*.

  ```bash
  curl -s -H "x-client: mobile" "http://127.0.0.1:4097/api/snippets?lang=en"      # chat
  curl -s -H "x-client: mobile" "http://127.0.0.1:4097/api/snippets/term?lang=ja" # terminal
  ```

## Requirements

- Node.js **≥ 22.19**
- Hermes Agent installed and running (the bridge proxies `http://127.0.0.1:9119`)
- Optional: [Tailscale](https://tailscale.com/) for HTTPS access from anywhere. On the same LAN, plain
  `http://<lan-ip>:4097` works without it.

## Install

```bash
npx hermes-pilot init
```

`init` is idempotent and does five things:

1. creates `~/.hermes/plugin-data/hermes-pilot/` (and `review/{sheets,shots,library}`),
2. generates a **256-bit hex app token** in `token` with mode `0600` (an existing token is never replaced),
3. if a legacy `~/Projects/akapen`, `~/.hermes/plugin-data/akapen` or `~/.hermes/mobile-pwa` exists, migrates
   it (files are **copied**, `mtime` preserved, kanban `[akapen]` tags rewritten to `[review]`),
4. copies the bundled skills `quick-review` and `annotation` into `~/.hermes/skills/`,
5. detects your reachable address (Tailscale MagicDNS name, otherwise the LAN IP) and prints the
   **pairing URL plus a QR code in the terminal**.

Then start the bridge:

```bash
npx hermes-pilot start                        # http://127.0.0.1:4097
npx hermes-pilot start --port 4097 --host 127.0.0.1
```

## Pairing a device (no long token to type)

- **From the terminal**: `npx hermes-pilot qr` prints the candidates and a QR. Pass `--tls-port 8444` when
  Tailscale `serve` publishes HTTPS on a non-443 port.
- **From the app**: Settings → *Pair a device* → *Show Pairing QR* (`GET /api/auth/pairing`). Show it to a
  second phone or tablet.

Scanning the QR opens `https://<host>/?token=<token>` (or `#token=`). The app exchanges the token for an
**HttpOnly session cookie** through `POST /api/auth/login` and immediately removes it from the address bar
with `history.replaceState`, so the token stays out of history, bookmarks and screenshots.

> The QR contains the app token. Anyone who scans it can control this Hermes — treat a screenshot of it like
> a password. Rotate the token with `rm ~/.hermes/plugin-data/hermes-pilot/token` and restart the bridge;
> every device is signed out.

## Keeping it running

```bash
npx hermes-pilot service install     # launchd on macOS, systemd --user on Linux
npx hermes-pilot service status
npx hermes-pilot service restart
npx hermes-pilot service uninstall
```

- macOS: `~/Library/LaunchAgents/ai.hermes.pilot.plist` (label `ai.hermes.pilot`), logs in
  `~/.hermes/logs/pilot.out.log` and `pilot.err.log`.
- Linux: `~/.config/systemd/user/hermes-pilot.service`
  (`systemctl --user enable --now hermes-pilot.service`).

### Migrating from `hermes-mobile-pwa` (HEADS-UP)

The service label changed from `ai.hermes.hermes-mobile` to `ai.hermes.pilot`, and the package name from
`hermes-mobile-pwa` to `hermes-pilot`. **The old agent is intentionally left running** so you can switch over
without downtime:

```bash
npx hermes-pilot init                     # copy the data (old files stay in place)
npx hermes-pilot service install          # register + start the NEW label
npx hermes-pilot service status           # confirm it is running

# once you are happy with the new one, retire the old one:
launchctl bootout gui/$(id -u)/ai.hermes.hermes-mobile
```

Both labels want port 4097. If the old agent is still bound to it, start the new one on another port first
(`npx hermes-pilot start --port 4098`), verify, then swap. The old `~/.hermes/mobile-pwa/` directory is
copied, never deleted — remove it yourself when you no longer need it.

## Data and environment

Everything persistent lives under `~/.hermes/plugin-data/hermes-pilot/`:

```text
config.json    { lang, scanDirs, servicePort, tlsPort? }
token          app token (0600)
audit.jsonl    audit log (every write)
repos.json     scanDirs / pinned / hidden / custom repositories
snippets.json  user chat snippets
review/        sheets/, shots/, library/, feed.jsonl, chat-reports.jsonl, task-chats.json
```

| Variable | Meaning |
|---|---|
| `HP_DATA_DIR` | plugin data dir (default `~/.hermes/plugin-data/hermes-pilot`) |
| `HM_DATA` | full override of the data dir (development/testing) |
| `HM_PORT` / `HM_HOST` | bridge listen address (default `4097` / `127.0.0.1`) |
| `HERMES_HOME` | Hermes home (default `~/.hermes`; a `profiles/<name>` path is normalized to the root) |

## How it works

| Item | Decision |
|---|---|
| Exposure | `https://<host>:8444` via Tailscale `serve`; bridge listens on `127.0.0.1:4097` only |
| Auth | app-token session cookie (`HttpOnly`, `SameSite=Strict`) + `X-Client: mobile` on writes |
| Kanban | each board's SQLite is read directly (read-only); there is no HTTP API for it |
| Kill switch | Hermes `/api/gateway/*` — never raw `launchctl` from the UI |
| Review data | `~/.hermes/plugin-data/hermes-pilot/review/` (sheets, shots, library, feed) |
| Completion feed | in-bridge `review-watcher.js` writes `feed.jsonl` / `chat-reports.jsonl` (no cron) |

## Development

```bash
npm install                 # postinstall fixes node-pty permissions
npm run dev                 # Vite on :4098, proxies /api and /ws to :4097
npm test                    # unit tests (402)
npm run verify              # tests + PWA 34-point check + production build
npm run deploy              # atomic, verified swap of apps/web/dist
npm run migrate:pilot       # the same migration as `init`, on demand
node bin/hermes-pilot.mjs --help
```

Layout:

```text
bin/hermes-pilot.mjs     CLI: init / start / qr / service / migrate
apps/bridge/src/         bridge (server.js, auth.js, review.js, qr.js, capabilities.js, ...)
apps/bridge/test/        bridge unit tests (qr.test.js compares against qrencode fixtures)
apps/web/src/            React PWA (i18n/, features/, lib/pairing.js, lib/theme.js)
apps/web/dist/           production build served by the bridge
skills/                  bundled quick-review / annotation skills
docs/                    SPEC-PUBLIC-PLUGIN.md (the spec), OPERATIONS.md, PLAN.md, EVIDENCE.md
```

QR generation is dependency-free (`apps/bridge/src/qr.js`): byte mode, error-correction level M, versions
1–10, SVG for the UI and ANSI half-block output for the terminal. Its module matrices are asserted against
`qrencode` reference fixtures in `apps/bridge/test/qr.test.js`.

## License

MIT
