---
name: autopilot-fastlane
description: "Run Autopilot prototyping in an isolated sandbox: batch-render HTML mocks, pass Pre-Flight Visual Gate checks, auto-resolve safe technical defaults, honor Style Gacha remixes, and promote approved designs."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [autopilot, prototyping, visual-gate, quick-review]
    category: workflow
    phase: prototype
    role: author
    abstract_roles: [role:decision-framer, role:planner, role:visual-reviewer]
    recommended_role: role:decision-framer
    quality_tier: decision-ready
---

# Autopilot Fast-Lane Protocol

Use this workflow during Autopilot Round 1 prototyping so users only see fast, visually grounded cards while production source files and test suites remain untouched until approval.

## Language

Write user-facing prose in the run's UI language — sheet title/topic/question/option text, SPEC prose, and the comments and summaries you post.
Keep machine tokens ASCII and unchanged: `label=`, `sheet=`, `mode=`, `round=`, `target=`, `chosenVariantId`, `stylePreset`, task ids, file paths, and SPEC keys.

## Abstract roles, delegation and fallback (model-agnostic)

This skill is **model-agnostic**. Never reference a specific model name, provider name, pricing tier, or local personal path.

- `role:decision-framer` — trims decisions to visual/UX forks and composes crisp comparison cards.
- `role:planner` — frames options and writes the promoted implementation SPEC once approved.
- `role:visual-reviewer` — reviews Pre-Flight Visual Gate results and redline annotations (`.annotated.png`).

## 1. Fast-Lane Sandbox Boundary

1. Write prototype HTML variants under `.hermes-pilot/sandbox/<slug>/` only.
2. Do **not** modify production source files or run heavy verification/build suites during Round 1 prototyping.
3. Keep each variant self-contained so it can render cleanly inside a sandboxed frame (`allow-scripts allow-forms`, no `allow-same-origin`).

## 2. Batch Mock Rendering & Pre-Flight Visual Gate

Render all option variants in a single headless browser launch using the repository's `render-mocks` helper targeting the mobile viewport declared by the target repository:

```bash
node scripts/render-mocks.mjs --manifest .hermes-pilot/sandbox/<slug>/manifest.json --json
```

Before attaching a mock screenshot to any card, confirm `status === "pass"` across all Pre-Flight checks:
- No horizontal overflow (`horizontal_overflow`)
- No broken images (`broken_images`)
- No overlapping interactive controls (`interactive_overlap`)
- Sufficient text contrast (`low_contrast`)

If any variant fails, fix its sandbox HTML and re-run `render-mocks` before presenting the deck.

## 3. Compact Mini-Previews (`snippetSelector`)

For focused layout, label-fit, or navigation questions where full-screen mocks add visual clutter, pass `"snippetSelector": "#target"` in the manifest variant so the renderer clips only that component as a compact preview card.

## 4. Safe Auto-Resolve Rules

Silently resolve and omit deck cards for reversible technical defaults that have zero visual or UX impact:
- **Safe to auto-resolve** (`affectsVisual: false`, `irreversible: false`): `file_layout`, `temp_flag_cleanup`, `component_split`, `i18n_key_naming`, `css_token_naming`, `internal_helper`.
- **Always ask the user**: `visual_layout`, `palette_theme`, `navigation_placement`, `info_hierarchy`, `destructive_data`, `public_publish`, `billing_cost`.

Record settled technical defaults concisely in `autoResolved` metadata so the final SPEC stays transparent.

## 5. Style Gacha (`stylePreset`)

When a `.remix.json` trigger specifies `stylePreset`, regenerate the mock variant in that visual direction (up to 3 remixes per card):
- `minimal` — clean whitespace, hairline borders, restrained palette
- `neon` — dark canvas, glowing cyber accents, crisp contrast badges
- `retro` — warm paper surface, tactile 2px borders, offset shadows
- `editorial` — serif hierarchy, magazine spacing and contrast
- `bento` — modular rounded tile grid with distinct block weights

## 6. Sandbox to Cockpit Promote Handoff

Once the user approves the final design, emit the normalized Promote payload into the production SPEC / batch pipeline:
- `chosenVariantId`
- `mockHtmlPath` (safe relative sandbox path)
- `screenshotPath` (safe relative path)
- `styleTag` (if applied)
- `annotations` (redline coordinates + notes)
- `autoResolved` (safe technical defaults settled earlier)

Only after Promote begins should the builder edit production source code and run the verification command the target repository declares.
