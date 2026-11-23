# Hermes Pilot

Drive an autonomous [Hermes Agent](https://hermes-agent.nousresearch.com/docs) from your phone or tablet.
**Hermes Pilot** turns the decisions an agent needs into one-tap review sheets and annotated screenshots,
carries a one-line idea all the way to filed, self-running kanban batches (**the A2B pipeline**), and puts
kanban, chat, terminal and usage into a single installable PWA.

日本語版は [`README.ja.md`](README.ja.md)。

**[▶ Try the interactive demo](https://hajimemanila.github.io/hermes-pilot/)** — no install, no Hermes: a self-contained mock of the A2B flow (Spec Seed → Quick Review → Spec Launchpad → Architect progress → Mission Receipt). The single file is also in this repo at [`demo/index.html`](demo/index.html) and embeds into Google Sites.

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
- **Spec Architect** — a one-line seed becomes a design interview, then a `docs/SPEC-*.md` whose batches a
  worker can execute without asking again. Skill: `skills/spec-architect/`.
- **Tasks / Inbox** — boards, task detail, event history, per-task git diff, approve / comment / abort, plus **🧠 Brainstorm** and **🛠 Refactor** sheets alongside **Spec Seed**.
- **Chat** — streaming Hermes chat with thinking log, tool log, attachments, snippets, cross-session search, bubble context menu (copy, save to Memos, summarize, continue instructing), and clear *Reply / RO* + running indicators in the session drawer.
- **Memos (Ideas & Report Inbox)** — Keep-style card grid for one-line capture, checklists, tags, search, and scheduled/completion report inbox, with direct handoff to Brainstorm and Spec Seed.
- **Terminal** — a real PTY over the bridge, with command snippets that follow your OS.
- **Persistent tab state** — all six tabs (Tasks, Review, Chat, Memos, Terminal, Settings) stay mounted in the background so switching tabs preserves scroll position, drafts, and loaded state without reload lag.
- **English and Japanese** (`en` is the fallback, `ja` is bundled), **Dark / Light / System** themes and two
  two-pane layouts: a **narrow master-detail from 680 px** (280 px master, for portrait tablets such as the
  iPad mini) and the **wide two-pane from 820 px** (380 px master for both Tasks and Review, 450 px
  from 1180 px, with the detail column full-bleed and its text capped at 1040 px). Below 680 px
  every detail opens as a full-height sheet.
- **No external plugins required** — repositories are found by scanning your project folders, and system
  status uses only the standard Hermes APIs.

## The A2B pipeline (seed → running batches)

One line of intent becomes a spec a worker can finish, without a chat backlog of questions.

```text
📝 Spec Seed ──► Quick Review ──► 📄 SPEC-<SLUG>.md ──► 🚀 Spec Launchpad ──► ⚡ live run ──► 🏆 Mission Receipt
 one line       3(±1) questions    Execution Mode per      idempotent batch      ArchitectJobBar    1200×630 PNG
 (or dictation) 1-tap answers      batch + acceptance      filing (kanban)       LiveSheet/WorkerFeed X-weight ≤ 280 text
```

**Two safe routes — neither spawns an external AI CLI:**

- **A. SPEC file → one-tap autonomous run (the basic route)** — place `docs/SPEC-*.md` (and, when you want a
  review round first, `review/sheets/*.json`) into the repository yourself: your terminal, the official
  Antigravity Remote PWA, or any editor. Hermes Pilot only watches the files (`Spec Launchpad` /
  `reviewWatcher`), so one tap files the batches and the autonomous run starts with no external process.
- **B. `Hermes Native` spec authoring (phone-only)** — `Spec Seed` → Quick Review → `docs/SPEC-*.md` →
  Launchpad, driven by `hermes kanban create` inside Hermes itself (steps 1–4 below).

1. **📝 Spec Seed** — type (or dictate) one line in the Tasks tab and pick an **execution policy**:
   - **`Zero-Stop`** (default) — every batch runs to the end autonomously; no approval stops.
   - **`Visual-Gate`** — the run pauses at checkpoints so you can look at the rendered result (screenshot /
     annotation) before the next batch starts.
   - **Runner** — fixed to `Hermes Native`: the Architect is driven inside Hermes itself, and Hermes Pilot
     never starts an external AI CLI as a subprocess (see *Two safe routes* above).
2. **Quick Review interview** — the Architect asks 3 (±1) questions on a sheet with recommended options; the
   *⚡ Accept All Recommended* button answers them all in one tap.
3. **📄 Spec** — a second round writes `docs/SPEC-<SLUG>.md`: decisions table, per-batch `Execution Mode`,
   changed-file list and acceptance commands, so a worker never has to ask "how should this work?".
4. **🚀 Spec Launchpad** — the Tasks tab lists the spec's `### Batch <ID>` entries with an accordion and
   Markdown preview, and files them as kanban tasks. A batch whose `[ID]` task is still open is skipped, and
   re-tapping or reloading never duplicates cards.
5. **⚡ Live run** — `ArchitectJobBar` shows the job's phase (`spawning → round1_sheet → round2_spec →
   spec_ready → launched`), a stall warning when a phase stops moving, and a one-tap retry for a job that
   failed or stalled. `LiveSheet` and `WorkerFeed` stream the running workers.
6. **🏆 Mission Receipt** — when the batches finish, the completion summary exports a **1200×630 PNG receipt**
   and a share text that is **X-weighted ≤ 280 characters in both JA and EN** (KPI numbers are never dropped;
   the header and footer give way first).

```bash
# 1) seed (returns 202 with a jobId; the Architect runs in the background)
curl -s -X POST -H "x-client: mobile" -H "content-type: application/json" \
     -d '{"board":"<board>","seedText":"Add a dark-mode receipt export","autoStart":false}' \
     "http://127.0.0.1:4097/api/architect/seed?t=$(cat ~/.hermes/plugin-data/hermes-pilot/token)"

# 2) job status / completed specs / un-filed specs
curl -s -H "x-client: mobile" \
     "http://127.0.0.1:4097/api/architect/jobs?board=<board>&t=$(cat ~/.hermes/plugin-data/hermes-pilot/token)"

# 3) file the batches (idempotent; same-board open tasks are skipped)
curl -s -X POST -H "x-client: mobile" -H "content-type: application/json" \
     -d '{"board":"<board>","specRelPath":"docs/SPEC-DARK-RECEIPT.md","batchIds":["B1","B2"]}' \
     "http://127.0.0.1:4097/api/specs/launch?t=$(cat ~/.hermes/plugin-data/hermes-pilot/token)"

# 4) done — completion summary + receipt data (read-only aggregation)
curl -s -H "x-client: mobile" \
     "http://127.0.0.1:4097/api/telemetry/receipt?board=<board>&hours=24&t=$(cat ~/.hermes/plugin-data/hermes-pilot/token)"
```

## Abstract roles and native delegation

A batch is routed by **role**, not by model name. Four abstract roles cover the whole pipeline, and they are
the only vocabulary the repo and the bundled skills use:

- `role:planner` — design, spec authoring, impact analysis, hard root-cause work.
- `role:builder` — implementation, test repair, builds, routine kanban work (the default).
- `role:visual-reviewer` — screenshot / annotation reading and `390×844` / `820×1180` visual acceptance.
- `role:decision-framer` — quick-review question design and trade-off framing.

A batch may declare `- **Recommended Role**: \`role:planner\``; the bridge extracts it and adds the role
guidance to the `[Hermes Pilot Execution Contract]` appended to the filed task. Specs without the line behave
exactly as before.

Delegation is **native** — Hermes's own `delegate_task` — and never an external AI CLI subprocess
(`gemini -p`, `agy -p`, …); `npm run check:oauth` fails if a runtime file tries to spawn one. It is also
**non-blocking**: if the delegated model errors, is rate-limited, times out or is not configured, the parent
continues on its own model in the fallback order its profile declares, and the batch still finishes. A failed
delegation never leaves a task stopped.

**Where the models are named: not here.** The repository and the three bundled skills speak only abstract
roles. The mapping (which role uses which model, in what fallback order) belongs to the operator and lives in
the Hermes profile — `~/.hermes/SOUL.md` for the short always-read contract, the profile's own `SOUL.md` and
memory for the concrete assignment table. That split is what keeps the plugin installable for anyone.
`POST /api/pipeline/optimize` writes the marker block into `~/.hermes/SOUL.md` and the Pilot profile
(`~/.hermes/profiles/mobile/SOUL.md`, created when missing). Other profiles are touched **only where the
marker already exists** — a profile that has never used Pilot keeps its `SOUL.md` byte-for-byte, and
appending to another profile requires naming it explicitly. Writes stay inside the markers, happen only
when the content changes, and take a `.bak-<stamp>` backup first; `GET /api/pipeline/status` reports which
profiles are applied without returning any file content.

## Decision cockpit (v2)

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
  node bin/hermes-pilot.mjs init --force      # refresh the dashboard plugin files after an upgrade
  ```

- **Snippet editing** — built-in snippets can be pinned to the chip bar (Hot) or hidden, and you can add,
  edit, reorder and delete your own, for chat and terminal, in English and Japanese, with
  *Reset to defaults*.

  ```bash
  curl -s -H "x-client: mobile" "http://127.0.0.1:4097/api/snippets?lang=en"      # chat
  curl -s -H "x-client: mobile" "http://127.0.0.1:4097/api/snippets/term?lang=ja" # terminal
  ```

## Comfort and one-tap setup

- **Vibe mode** — `⚡ Dopamine ⇄ 🧘 Serotonin` in Settings changes how loud the app is (HUD bevels,
  chat bubble glow, topbar/badge pulses, `sakuga-vfx`-inspired spring & canvas bursts with EN/JA
  onomatopoeia, `Working…` aurora borders, and the receipt canvas title), not what it does. Haptics and
  sound are separate toggles and **survive a Vibe switch**, so turning the volume down never silently
  disables the buzz you rely on.
- **Snippet band toggle** — the chip band above the chat composer, the annotation toolbar and the terminal
  keys can each be collapsed. The choice is per band and remembered, so a small phone keeps the composer and
  the keyboard from fighting for the same 390 px.
- **1-tap environment optimisation** — *Settings → Optimise this Hermes* (`POST /api/pipeline/optimize`)
  adds the A2B discipline section (English; prose language stays with your profile) to `~/.hermes/SOUL.md`
  and to the Pilot profile `~/.hermes/profiles/mobile/SOUL.md`. Other profiles are updated only if they
  already carry the marker, so an unrelated profile's `SOUL.md` is never edited (idempotent — an existing
  section is never duplicated, and a `.bak-<stamp>` backup is taken first). It then places the three
  bundled skills into `~/.hermes/skills/`.
  `GET /api/pipeline/status` reports what is already applied, per profile, without returning any `SOUL.md`
  content.
- **Legacy cron cleanup** — `migrate` (and `init`) removes the old `mobile-akapen-watch` /
  `mobile-review-watch` cron entries, because the bridge's own watcher writes the completion feed now and two
  writers produced duplicate reports. Other cron entries and the store's top-level shape are untouched.

## Interactive demo (no backend needed)

`npm run build:demo` produces a static site in `apps/web/dist-demo` that needs **no bridge, no gateway and no
database** — put it on GitHub Pages (or any static host) and anyone can walk the pipeline.

```bash
npm run build:demo          # VITE_DEMO_MODE=1, base ./, outDir apps/web/dist-demo
npx serve apps/web/dist-demo   # or: python3 -m http.server -d apps/web/dist-demo 4321
```

- **On a phone** it is the normal PWA, opened straight in the browser (no device frame).
- **On a desktop browser (≥ 900 px)** the app is shown inside a device simulator: `Phone 390×844`,
  `Tablet 820×1180` (the two-pane layout) or `Full window`, plus instant `Dopamine ⇄ Serotonin`,
  sound, `Dark ⇄ Light`, `EN ⇄ JA` and *Restart tour*. The frame is a real `<iframe>`, so media queries,
  `position: fixed` sheets, toasts and the bottom nav behave exactly as on the device.
- **A 4-step guided tour** (top banner with a jump button on every step): ① approve the Architect's
  decision sheet with *Accept All Recommended* → ② file the generated spec's batches and watch them run →
  ③ stamp a redline or accept the Before ↔ After visual gate → ④ open the completion summary and the
  **completion receipt** (1200×630 PNG / share text).

All data is in memory (`apps/web/src/demo/mockApi.js`); the screenshots used by the visual gate are
generated as inline SVG data URLs, so the demo has no network dependency at all.

**Production is untouched**: `main.jsx` reads `import.meta.env.VITE_DEMO_MODE`, so a normal `npm run build`
strips the demo branch and its dynamic imports — `apps/web/dist` contains no mock code, no tour CSS and no
screenshots (only the `demo.*` UI strings that live in the shared dictionaries). `apps/web/dist-demo` is
git-ignored and excluded from `npm pack`.

### Google Sites (single-file embed)

`npm run build:demo` also writes **`apps/web/dist-demo/google-sites-embed.html`**: one self-contained file
with the JS, CSS and SVG images inlined, `localStorage` replaced by an in-memory shim and the PWA `<link>`
tags removed. The build fails (`exit 1`) if any external reference survives its own `verifyEmbedHtml()`
check, so a broken file cannot reach the site.

1. `npm run build:demo`
2. Google Sites → *Insert* → **Embed** → **Embed code** → paste the whole content of
   `google-sites-embed.html` → *Insert*.
3. Open the page on a desktop browser: because the embedded document knows it is a frame
   (`window.__HM_DEMO_FRAME__`), it still renders the **`Phone 390×844` / `Tablet 820×1180` / `Full window`**
   device simulator with its top bar. *Restart tour* re-creates the inner iframe instead of reloading the
   `srcdoc` page, so it works inside Google Sites too.
4. For GitHub Pages, publish `apps/web/dist-demo` as-is (relative `base`); the embed file is optional there.

## Requirements

- Node.js **≥ 22.19**
- Hermes Agent installed and running (the bridge proxies `http://127.0.0.1:9119`)
- Optional: [Tailscale](https://tailscale.com/) for HTTPS access from anywhere. On the same LAN, plain
  `http://<lan-ip>:4097` works without it.

## Install

Three routes. **A** is the shortest (one command, no clone); **B/C** install it as a Hermes plugin
so the dashboard tab and the bundled skills are wired up for you.

**A. From npm (published package)**

```bash
npx hermes-pilot@0.2.4 init      # data dirs, token, bundled skills, pairing QR (idempotent)
npx hermes-pilot@0.2.4 start     # bridge on http://127.0.0.1:4097
```

To keep it running across logins instead, install it once and use the `service` subcommand:

```bash
npm i -g hermes-pilot@0.2.4
hermes-pilot service install     # launchd on macOS, systemd --user on Linux
```

`hermes-pilot` on npm: <https://www.npmjs.com/package/hermes-pilot> (pin the version; `@latest`
tracks the newest release). The package `postinstall` restores the `spawn-helper` exec bit that
npm's tarball extraction drops, so the terminal tab works without extra steps.

**B. From the Hermes plugin catalog**

```bash
hermes plugins install hermes-pilot      # catalog entry: the reviewed pin is used as-is
cd ~/.hermes/plugins/hermes-pilot
npm ci
node bin/hermes-pilot.mjs init
```

Installing straight from GitHub instead of the catalog works too, but pass a **full 40-character
commit SHA** (`--ref v0.2.4` is rejected — tags and branches are refused by design) and expect one
`--force` confirmation, because an owner/repo source is scanned as an unreviewed community source:

```bash
hermes plugins install hajimemanila/hermes-pilot --ref <40-char-sha>   # not a tag, not a branch
```

**C. From a clone of this repository**

```bash
git clone https://github.com/hajimemanila/hermes-pilot.git
cd hermes-pilot
npm ci
node bin/hermes-pilot.mjs init
```

For **B/C**, `npm ci` is not optional: the bridge needs `ws` and the **native** addon `node-pty`,
and the `postinstall` step restores the `spawn-helper` exec bit (without it the terminal tab fails
with `posix_spawnp failed`). Every `node bin/hermes-pilot.mjs …` below assumes the current
directory is that repository / plugin directory; with route **A** use `hermes-pilot …` instead.

`init` is idempotent and does five things:

1. creates `~/.hermes/plugin-data/hermes-pilot/` (and `review/{sheets,shots,library}`),
2. generates a **256-bit hex app token** in `token` with mode `0600` (an existing token is never replaced),
3. if a legacy `~/Projects/akapen`, `~/.hermes/plugin-data/akapen` or `~/.hermes/mobile-pwa` exists, migrates
   it (files are **copied**, `mtime` preserved, kanban `[akapen]` tags rewritten to `[review]`),
4. copies the bundled skills `quick-review`, `annotation` and `spec-architect` into `~/.hermes/skills/`,
5. detects your reachable address (Tailscale MagicDNS name, otherwise the LAN IP) and prints the
   **pairing URL plus a QR code in the terminal**.

Then start the bridge:

```bash
node bin/hermes-pilot.mjs start                        # http://127.0.0.1:4097
node bin/hermes-pilot.mjs start --port 4097 --host 127.0.0.1
```

## Pairing a device (no long token to type)

- **From the terminal**: `node bin/hermes-pilot.mjs qr` prints the candidates and a QR. Pass `--tls-port 8444` when
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
node bin/hermes-pilot.mjs service install     # launchd on macOS, systemd --user on Linux
node bin/hermes-pilot.mjs service status
node bin/hermes-pilot.mjs service restart
node bin/hermes-pilot.mjs service uninstall
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
node bin/hermes-pilot.mjs init                     # copy the data (old files stay in place)
node bin/hermes-pilot.mjs service install          # register + start the NEW label
node bin/hermes-pilot.mjs service status           # confirm it is running

# once you are happy with the new one, retire the old one:
launchctl bootout gui/$(id -u)/ai.hermes.hermes-mobile
```

Both labels want port 4097. If the old agent is still bound to it, start the new one on another port first
(`node bin/hermes-pilot.mjs start --port 4098`), verify, then swap. The old `~/.hermes/mobile-pwa/` directory is
copied, never deleted — remove it yourself when you no longer need it.

## Security

The bridge is the only thing listening, and it is the only thing that can reach Hermes.

| Surface | Rule |
|---|---|
| Listen address | `127.0.0.1:4097` by default. Nothing is exposed unless you put Tailscale `serve` (or another TLS proxy) in front of it. |
| Device credential | A 256-bit hex app token in `~/.hermes/plugin-data/hermes-pilot/token` (`0600`). It is exchanged once for an **`HttpOnly`, `SameSite=Strict` session cookie**; the token is then stripped from the address bar with `history.replaceState`. |
| QR pairing | The QR carries a **one-time pairing code** (10-minute TTL, single use), not the app token. Treat a screenshot of it as a password anyway; rotations are `rm …/token` + restart, which signs every device out. |
| Hermes session token | Never leaves the bridge. The PWA only ever holds the app token / cookie. |
| Writes | Every mutating call needs the **`X-Client: mobile`** header (401 without it) **and** the session cookie, so a cross-site form post cannot drive the app. |
| Kill switch | Long-press 1.5 s + typed confirmation, and the API re-checks the `confirm` field. The UI never shells out to raw `launchctl`. |
| Rate limits | Reads 120/min per endpoint bucket, writes 60/min. |
| Audit | Every write appends to `~/.hermes/plugin-data/hermes-pilot/audit.jsonl` (viewable in Settings). |
| Read-only data | Kanban SQLite, usage and receipts are opened read-only; the bridge aggregates them and never migrates a board on its own. |
| Public paths | Only the app shell (`/`, `/assets/*`, `/manifest.webmanifest`, `/sw.js`, `/icon-*`, `/auth`, `/healthz`) is unauthenticated — Android's WebAPK generator fetches those without credentials. Everything under `/api/*` and `/ws/*` is behind auth. |
| Demo | `apps/web/dist-demo` (and the Google Sites embed) is **mock data only** — no token, no bridge, no network calls; nothing from it can reach your Hermes. |

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

## Coherence diagnostics

Large repos drift in ways unit tests never catch: one file absorbs every change, a contract is fixed in the web
layer but not in the mock, finished specs bury the Launchpad. Hermes Pilot runs a **read-only** coherence pass and
turns the drift into a one-tap proposal — it never files work on its own.

- **Layer 1 (zero config).** Works in any Git repo, any language: `git-hotspot` (files touched 5+ times in 14 days),
  `file-bloat` with a shrink-only ratchet, `spec-sprawl` (too many unarchived specs), `debt-spike` (`TODO`/`FIXME`
  concentration in recently changed files).
- **Layer 2 (opt-in).** Drop a `.hermes-coherence.json` (max 64 KB) at the root of the target repo to set
  `maxLines`, `ignoreGlobs`, `hotspotDays`, `hotspotTouches`, `baselineFile`, `forbiddenPatterns` and an optional
  `checker` (a repo-local `.mjs`/`.js`, 10 s timeout, `--json` contract). The keys and a full example are in
  [docs/OPERATIONS.md](docs/OPERATIONS.md).
- **Where it shows up.** When the pipeline finishes, the completion report gains a `coherence_alert` and one extra
  recommended next step. The Tasks tab grows a collapsible banner (thresholds: any hard fail, ≥1 hotspot, ≥3 soft
  signals); one tap opens the sweep sheet with the recommended preset already selected, and dismissals are keyed to
  the counts so a new level of drift comes back.
- **Ratchet.** Existing oversized files are pinned in `scripts/coherence-baseline.json`; the baseline may only be
  lowered (`--update-baseline`), never raised silently — new UI lands in its own file instead.
- **Spec archive.** Mark a finished spec with `- **Status**: archived` in its first 40 lines (or move it under
  `docs/archive/`) and the Launchpad hides it by default; `Show archived (N)` brings it back.

When the banner misbehaves (never shows, never goes away, an archived spec seems lost), see
[docs/PITFALLS.md](docs/PITFALLS.md) P8.

## Development

```bash
npm install                 # postinstall fixes node-pty permissions
npm run dev                 # Vite on :4098, proxies /api and /ws to :4097
npm test                    # unit tests (933)
npm run verify              # test + check:pwa (34 checks) + check:oauth + production build + audit:responsive + check:coherence
npm run check:coherence     # Layer 2 contract parity: api / events / storage / docs / legacy symbols
npm run build:demo          # static interactive demo -> apps/web/dist-demo (+ google-sites-embed.html)
npm run deploy              # atomic, verified swap of apps/web/dist
npm run migrate:pilot       # the same migration as `init`, on demand
node bin/hermes-pilot.mjs --help
```

`npm run verify` is the gate every change has to pass, measured on this tree:

| Step | What it proves |
|---|---|
| `npm test` | **933** unit / integration tests, 0 fail (node:test, no framework). |
| `check:pwa` | **34/34** PWA checks against `apps/web/public` (manifest, icons, maskable, service worker, viewport). |
| `check:oauth` | **0** violations: no device credential or OAuth token is readable from the browser bundle. |
| `build` | Vite production build succeeds and contains no `demo/` code. |
| `audit:responsive` | layout audit at `390×844`, `844×390`, `820×1180` … — tap targets ≥ 44 px, no clipping regressions. |
| `check:coherence` | **5** Layer 2 rules (`api-parity`, `event-contract`, `storage-contract`, `docs-scripts-parity`, `legacy-reentry`), 0 hard fail. |

Layout:

```text
bin/hermes-pilot.mjs     CLI: init / start / qr / service / migrate
apps/bridge/src/         bridge (server.js, auth.js, review.js, qr.js, capabilities.js, ...)
apps/bridge/test/        bridge unit tests (qr.test.js compares against qrencode fixtures)
apps/web/src/            React PWA (i18n/, features/, lib/pairing.js, lib/theme.js)
apps/web/src/demo/       interactive demo only (mockApi.js, DemoStage.jsx, demo.css) — never in dist/
apps/web/dist/           production build served by the bridge
apps/web/dist-demo/      static demo build (`npm run build:demo`, git-ignored)
skills/                  bundled skills: quick-review / annotation / spec-architect
docs/                    SPEC-PUBLIC-PLUGIN.md (the spec), OPERATIONS.md, PLAN.md, EVIDENCE.md
```

QR generation is dependency-free (`apps/bridge/src/qr.js`): byte mode, error-correction level M, versions
1–10, SVG for the UI and ANSI half-block output for the terminal. Its module matrices are asserted against
`qrencode` reference fixtures in `apps/bridge/test/qr.test.js`.

## License

MIT
