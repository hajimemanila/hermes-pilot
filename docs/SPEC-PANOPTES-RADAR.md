# SPEC-PANOPTES-RADAR — Orbital Context-Eye Radar BI for Autopilot Mobile UI

> **Status:** Archived (`PN-1..PN-3` implemented and deployed)  
> **Batch prefix:** `PN`  
> **Extends:** `docs/SPEC-AUTOPILOT-V3.md` (Archived `AP3-1..AP3-4`)  
> **Target:** Hermes Mobile PWA (`apps/web`, `apps/bridge`, `docs`)  
> **Inspiration:** Clean-room React + SVG orbital telemetry UI inspired by `huwhitememes/panoptes` (MIT License)

---

## 1. Purpose & Design Goals

During long-running Autopilot phases (`[ARCH]` design generation, mock rendering, and parallel Zero-Stop batch execution), users need immediate feedback that the system is alive, where effort is going, whether context capacity or errors need attention, and one-tap controls — all comfortably inside a `390×844` mobile screen without external charting libraries.

### Key Capabilities

1. **8 Orbital Stations (`YOU / FILES / SHELL / WEB / BROWSER / AGENTS / MEMORY / TOOLS`)**:
   - Every tool call maps deterministically (`toolToStation(toolName)`) to one of 8 stations arranged clockwise around the radar perimeter.
   - Spoke thickness scales dynamically with call frequency (`1.2px..4.0px`).
   - Failed commands mark the owning station with a high-contrast red dot and keep the last 3 non-empty lines of stderr/output.
   - Each station also carries an intuitive, beginner-friendly Autopilot stage label (e.g. `FILES` → file editing / reading, `BROWSER` → mock preview capture, `YOU` → awaiting user input).
2. **Interactive Central Context Eye**:
   - Concentric iris ring shows live context window usage percent with health color coding: teal (`< 70%`), amber (`70%..89%`), and red (`>= 90%`).
   - Eye pupil tracks toward the currently active station angle and blinks when tool calls advance.
   - Tapping the center core toggles between `Context %` and `Cache Hit % / Session Cost` (`99% · $0.08`).
3. **Interactive Tap Interventions**:
   - Tapping blinking `YOU` refreshes pending reviews and focuses decision cards (`onFocusReview`).
   - Tapping `BROWSER` opens an inline preview strip of the latest captured mock screenshot (`previewShotUrl`) when available.
   - Tapping any red error dot / failed station opens an inline 3-line error tail card right inside the inspector without leaving Autopilot.
4. **Vibe Mode & Reduced Motion Coupling**:
   - Under `html[data-vibe='dopamine']`: rotating sweep wedge, radial pulse travelling along active spokes, eye completion blink, and `YOU` attention ping animate smoothly (CSS-only).
   - Under `html[data-vibe='serotonin']` and `@media (prefers-reduced-motion: reduce)`: all sweep/pulse/blink/ping animations stop cleanly, keeping a crisp static iris gauge and active station highlight.
5. **Interactive Demo Parity**:
   - Demo `/api/live` telemetry drives a deterministic 4-step sequence (`FILES → SHELL → BROWSER → YOU`) using the studio clock so first-time users immediately experience the live orbital radar during Autopilot waits.

---

## 2. Batch Plan (All `[Mode: Zero-Stop]`)

### Batch PN-1: PANOPTES-BRIDGE-TELEMETRY — `/api/live` Duration, Tool Error Tail & Context Ratio

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: Extend `apps/bridge/src/live.js` to extract per-tool duration (`durationMs`), non-trivial error detection with last 3 lines (`failed`, `errorTail`), recent call history up to 12 items per active turn (`toolSamples` / `telemetry.toolHistory` / `telemetry.failedTools`), and session context ratio (`contextPct`) with full backward compatibility for minimal SQLite test fixtures.
- **Files**:
  - `apps/bridge/src/live.js`
  - `apps/bridge/test/liveTelemetry.test.js`
- **Verify**:
  - `node --test apps/bridge/test/liveTelemetry.test.js` passes all existing and new assertions (`failedTools`, `errorTail`, `"0 fail"` non-false-positive, `durationMs`, `contextPct`).
  - `apps/bridge/src/server.js` remains untouched (`<= 794` lines).

### Batch PN-2: PANOPTES-ORBITAL-PROJECTION — Pure 8-Station Orbital Engine & Demo Parity

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: Implement deterministic `toolToStation`, 8 orbital station coordinates (`RADAR_STATIONS`), spoke thickness weighting, error propagation, `contextHealthTone`, `computePupilOffset`, `formatDurationMs`, `formatCostUsd`, and 4-step Demo radar sequence in `apps/web/src/lib/liveRadar.js` and `apps/web/src/demo/fetch.js` while keeping all existing exports and 0-based `runTracked` token behavior intact.
- **Files**:
  - `apps/web/src/lib/liveRadar.js`
  - `apps/web/src/demo/fetch.js`
  - `apps/web/test/LiveRadarCard.test.js`
- **Verify**:
  - All 8 stations, pupil coordinates, context health thresholds, error detection, and demo sequence pass in `LiveRadarCard.test.js`.

### Batch PN-3: PANOPTES-ORBITAL-UI — Interactive Context-Eye SVG, Vibe Gating & Mobile Audit

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: Upgrade `LiveRadarCard.jsx` to pure React + SVG Panoptes orbital BI (`Context Eye`, 8 tappable stations, inline `BROWSER` screenshot / 3-line error inspector, `YOU` review focus, 3-row LIVE FEED with durations), wire `clockNow` / `previewShotUrl` / `onFocusReview` through `AutopilotCards.jsx` & `AutopilotView.jsx`, add `Dopamine` vs `Serotonin` animation gating in `autopilot-radar.css`, add EN/JA i18n keys, and verify `390×844` + `390×664` viewports in real headless Chrome before deploy and bridge restart.
- **Files**:
  - `apps/web/src/features/autopilot/LiveRadarCard.jsx`
  - `apps/web/src/features/autopilot/AutopilotCards.jsx`
  - `apps/web/src/features/autopilot/AutopilotView.jsx`
  - `apps/web/src/styles/autopilot-radar.css`
  - `apps/web/src/i18n/en.json`
  - `apps/web/src/i18n/ja.json`
  - `apps/web/test/autopilotV3Ux.test.js`
- **Verify**:
  - `npm test`, `npm run check:dashboard`, `npm run check:pwa`, `npm run check:oauth`, `npm run build`, `npm run build:demo`, and `node scripts/check-coherence.mjs --strict` pass with 0 hard fails.
  - Headless Chrome (`390×844` and `390×664`) confirms 8 stations, Context Eye toggle, station inspector tap, `Dopamine`/`Serotonin` animation gating, zero horizontal overflow, and clean `npm run deploy` + `hermes-pilot service restart`.
