# SPEC-AUTOPILOT-XRAY — Interactive X-Ray Previews, Live Nudge, Dual-Worker Pulses & Step Review Drawer

- **Status**: archived  
> **Batch prefix:** `XR`  
> **Extends:** `docs/SPEC-PANOPTES-RADAR.md` (Archived `PN-1..PN-3`)  
> **Target:** Hermes Mobile PWA (`apps/web`, `apps/bridge`, `docs`)

---

## 1. Purpose & Design Goals

Upgrade the Autopilot waiting radar from passive telemetry into an interactive cockpit where casual mobile users can inspect concrete progress inside each station, inject non-interrupting tweaks (`Live Nudge`) queued for the next task boundary, visually feel multiple parallel workers operating simultaneously, and tap completed phases (`設計` / `制作`) to review what was agreed and built.

### Capabilities

1. **Station X-Ray Previews**:
   - `BROWSER` (`MOCK`): tapping shows the latest captured screenshot inline right inside the inspector.
   - `FILES`: tapping reveals changed filename + `+added / -removed` diff bar (e.g. `detail.css +18 / -4`).
   - `SHELL`: tapping renders a beginner-friendly 1-line command intent summary + pass/fail badge + command snippet (and last 3 lines on error).
2. **Live Nudge (Queued Non-Interrupting Instructions + `YOU` Amber Pin)**:
   - Footer action sends `POST /api/memos` (`tags: ['autopilot', 'nudge']`) and appends `[LIVE NUDGE]` to the active task via `POST /api/boards/:board/tasks/:id/comment` without killing or restarting running workers.
   - Lights a blinking amber pin on the `YOU` orbital station; advances queued → applied automatically when the next task begins.
3. **Parallel Worker Visual Separation**:
   - Assigns worker colors (`w1` teal, `w2` amber, `w3` violet) across active turns/tasks and renders simultaneous color-coded pulses and worker badges toward their active stations.
4. **Tappable 4-Step Progress Review Drawer**:
   - Users can tap completed or current phase buttons (`設計` / `制作` / `テスト` / `仕上げ`) to inspect an inline summary drawer (agreed requirement + answered reviews; modified file count + diff summary; check status; preview readiness).

---

## 2. Batch Plan (All `[Mode: Zero-Stop]`)

### Batch XR-1: XRAY-BRIDGE-TELEMETRY — File Diff, Command Args & Demo Comment Parity

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: Extract structured `filePath`, `addedLines`, `removedLines`, and `command` per tool invocation in `apps/bridge/src/live.js`, aggregate `telemetry.fileChanges`, and add `/api/boards/:board/tasks/:id/comment` + X-Ray demo telemetry in `apps/web/src/demo/{route,fetch}.js`.
- **Files**:
  - `apps/bridge/src/live.js`
  - `apps/bridge/test/liveTelemetry.test.js`
  - `apps/web/src/demo/route.js`
  - `apps/web/src/demo/fetch.js`
- **Verify**:
  - `node --test apps/bridge/test/liveTelemetry.test.js` passes all X-Ray and legacy telemetry assertions.
  - `apps/bridge/src/server.js` remains untouched (`<= 794` lines).

### Batch XR-2: XRAY-PROJECTION-WORKERS — Worker Palette, Command Intent, Diff & Nudge State

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: Add `WORKER_PALETTE`, `summarizeCommandIntent`, parallel `workers[]` separation, `fileChanges`, and `queuedNudges` pinning onto `YOU` in `apps/web/src/lib/liveRadar.js`, plus persist `nudges` in `apps/web/src/lib/autopilot/studio.js` without changing the 27-export `autopilotDeck.js` barrel.
- **Files**:
  - `apps/web/src/lib/liveRadar.js`
  - `apps/web/src/lib/autopilot/studio.js`
  - `apps/web/test/LiveRadarCard.test.js`
- **Verify**:
  - `node --test apps/web/test/LiveRadarCard.test.js` passes multi-worker, command intent, fileChanges, and nudge pin tests.

### Batch XR-3: XRAY-ORBITAL-UI — Inline X-Ray, Multi-Worker Pulses, Live Nudge & Step Drawer

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: Render dual-worker color pulses, amber nudge pin, and inline X-Ray file diff / command intent previews in `LiveRadarCard.jsx`, add interactive 4-step review drawer + `⚡ 割り込み指示` wiring in `AutopilotCards.jsx` & `AutopilotView.jsx`, update `autopilot-radar.css` / `autopilot-deck.css` / `en.json` / `ja.json` with Vibe gating, and verify on real headless Chrome (`390×844` & `390×664`) before deploy and restart.
- **Files**:
  - `apps/web/src/features/autopilot/LiveRadarCard.jsx`
  - `apps/web/src/features/autopilot/AutopilotCards.jsx`
  - `apps/web/src/features/autopilot/AutopilotView.jsx`
  - `apps/web/src/styles/autopilot-radar.css`
  - `apps/web/src/styles/autopilot-deck.css`
  - `apps/web/src/i18n/en.json`
  - `apps/web/src/i18n/ja.json`
  - `apps/web/test/autopilotV3Ux.test.js`
- **Verify**:
  - `npm test`, `npm run check:dashboard`, `npm run check:pwa`, `npm run check:oauth`, `npm run build`, `npm run build:demo`, and `node scripts/check-coherence.mjs --strict` pass (`0 hard fail(s)`).
  - Headless Chrome (`390×844` & `390×664`) confirms X-Ray `FILES`/`SHELL`/`BROWSER`, Live Nudge `YOU` pin, dual-worker pulses, tappable step drawer, `npm run deploy`, and `hermes-pilot service restart`.
