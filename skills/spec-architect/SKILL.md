---
name: spec-architect
description: "Turn a one-line seed into a SPEC the batch runner can execute: sheet-driven interview, then docs/SPEC-<SLUG>.md with Execution Mode per batch."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [architect, spec, interview, quick-review, a2b-pipeline, kanban]
    category: workflow
    phase: design
    role: architect
    abstract_roles: [role:planner, role:builder, role:visual-reviewer, role:decision-framer]
    recommended_role: role:planner
    quality_tier: decision-ready
---

# Spec Architect (turn one line into a spec a runner can finish alone)

The Architect's job is not "writing a spec"; it is **producing, in two rounds, a spec that the
Builder (the autonomous kanban worker) can finish without asking anything extra**. Do not line up
long questions in chat. Put decisions on a question sheet so a human answers with one tap.

This skill ships with the **`hermes-pilot` plugin**. `hermes-pilot init` installs it into both
`~/.hermes/skills/spec-architect/` and `~/.hermes/profiles/<pilot>/skills/spec-architect/`.

## Language

Write user-facing prose in the run's UI language — sheet title/topic/question/option text, SPEC prose, and the comments and summaries you post.
Keep machine tokens ASCII and unchanged: `label=`, `sheet=`, `mode=`, `round=`, `target=`, task ids, file paths, and the SPEC keys **Execution Mode** / **Objective** / **Files** / **Verify**.
This matches the bridge prompt language rule: when the run's language is Japanese, only the prose switches to Japanese; the machine line and paths stay ASCII.
The rule covers the sheet you write and every prose line you post to the board, including the 1-line `complete --summary`.

## When to use it

Use it:
- Turning a one-line note / voice dictation (`Spec Seed`) into an implementation plan
- Adding a new group of features (several batches) to an existing repository
- The human can say "what to build" but has not decided "how to build it"

Do not use it:
- The change is one file with a unique answer (implement it and run the verification command declared by the target repository)
- `docs/SPEC-*.md` already exists and you only need to file it through the hermes-pilot spec launcher

## Two-round protocol

### Round 1 — interview straight into Quick Review

Instead of listing questions in chat, build **exactly one question sheet**.
**The first choice is structured JSON (`mode=standard`)**. Hand-written HTML and headless-browser
captures are an optional extension for "the visual comparison itself is the question".

1. **3±1 questions.** Each question is "one thing a human decides". Put the facts (`file:line`,
   command output) in the body and leave only the decision to the human. Keep each question concise
   for mobile readability: summarize long `file:line` lists as 1-2 representative locations plus
   the total count instead of dumping long slash-joined lists. Evidence needs only a
   **minimal check of the relevant spot** (do not build out the whole repo or mock things up; file the
   sheet as soon as it is decided).
   **Do not run full test or verification suites in Round 1.** Explore with `rg` / `grep` for the specific
   symbols; do not spend time checking every dependency or building. Tests and builds belong in
   Round 2, written into the SPEC (each batch's Verify). Once the sheet is written, **block immediately**.
2. Two or three options per question, one `recommended: true`. Always give the reason (gain / cost).
3. Draw both options **only** for visual questions (placement, information density, colour comparison).
   Everything else (spec, logic, wording, API, data design) is filed as `.json` alone and blocked
   immediately — no headless-browser capture and no 300-line HTML. When a picture is needed for an
   existing screen, first capture a faithful shot of the current UI.
4. Same location and format as the `quick-review` skill. **The primary artefact is `.json`:**

```text
~/.hermes/plugin-data/hermes-pilot/review/sheets/spec-<slug>-1.json   <- primary (mode=standard)
~/.hermes/plugin-data/hermes-pilot/review/sheets/spec-<slug>-1.html   <- only for visual questions
```

5. File it on kanban and set it **blocked** (do not implement until the answer arrives):

```bash
hermes kanban --board <board> create "Q1-Q3: design direction for <project>" --assignee <profile> --idempotency-key "review:spec-<slug>:round-1" --body "$(cat <<'BODY'
<What unblocks writing the spec. What is stuck right now.>

[review] label=spec-<slug> round=1 mode=standard sheet=sheets/spec-<slug>-1.json target=<repo_path> chat=<session_id>
BODY
)"
hermes kanban block <task_id> "Waiting for the spec interview (Q1-Q3)" --kind needs_input
```

- When Round 1 is started from an `[ARCH]` task and delegates Round 2 to a separate `[review]` card,
  copy the Round 2 batch heading (`### Batch <SLUG>-<n>: <Title>`) and per-batch `- **Execution Mode**:`
  requirements into that `[review]` card's body, then mark the parent `[ARCH]` task `done` once the `[review]`
  card is `blocked`.

With the `.json` alone both the PWA native form (`<StandardForm>`) and "open the whole sheet ↗" work
(when `.html` is missing the bridge generates safe HTML from the `.json`).

#### Visual-first Autopilot Deck Mode (optional)

When the seed designs a new UI/screen or visual direction (or runs in Autopilot mode), emit **one 3-card deck** (`"deck": true`) in Round 1 (`sheets/spec-<slug>-1.json`) so the user can swipe all three cards in one pass:

1. **Card 1 (`q1`)**: Primary screen layout with `visualMock` (`shot` under `shots/` and/or lightweight static `html` under `sheets/`, rendered at the mobile viewport declared by the target repository — use a lightweight template so Card 1 is ready immediately).
2. **Card 2 (`q2`)**: Key interaction flow or modal/state variant with `visualMock`.
3. **Card 3 (`q3`)**: Data persistence, scope, or edge-case policy (structured options with `recommended: true`).

If the user swipes left (REMIX), `.remix.json` (`{ questionId, reason, hint }`) is written and the task unblocks: regenerate the targeted card's `visualMock` / options in that direction and re-block.

While waiting, work on other tasks. **Never invent answers.**

### Round 2 — generate the SPEC

Read the answers (`.answer.json` / `.answer.txt` / the `[Review Answer]` comment) and write
`docs/SPEC-<SLUG>.md`. `(unselected = take recommended)` may be settled with the recommendation.
If `.answer.json` contains `annotations` (`{ questionId, shot, marks, note }`), inject those redlined coordinates and notes into the matching batch's **Objective** and **Verify** as mandatory requirements, and verify in the final `[Mode: Visual Gate]` (`role:visual-reviewer`) pass that every annotated mock region is reflected in the live screenshot.

Required format (the Hermes Pilot spec parser reads it mechanically. **Do not change the shape**):

```markdown
# SPEC: <project name> (`SPEC-<SLUG>`)

Status: decided (<date>, interview Q1-Q3 agreed)
Based on: <link the previous SPEC if any>

## 1. Concept

<3-6 lines. What, for whom, how far.>

## 2. Agreed decisions (interview outcome)

| # | Topic | Decision | Rationale |
|---|---|---|---|
| **D1** | <question> | <decision> | <why> |

## 3. Detailed technical spec

### 3.1 <area>

Targets: <file>, <file>

1. **<feature>**: <spec, down to function names, storage keys and endpoint names>

## 4. Kanban task breakdown (Batch <SLUG>-1 .. <SLUG>-N)

### Batch <SLUG>-1: <batch name>

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: <1-3 lines. What goes into which file.>
- **Files**:
  - New: `<path>`
  - Changed: `<path>`
- **Verify**:
  - <observable condition, down to test file names>
  - The verification command the target repository declares (its profile memory, `AGENTS.md`, or **Verify**) passes.

---
```

## Batch heading rules (break these and filing breaks)

- Batch headings must be **`### Batch <ID>: <Title>`** only. `<ID>` starts with a letter and is at most
  16 characters (`V5-1` / `P2` / `T3` are fine, `1.1` is not).
- Any other `###` heading **must start with a digit** (`### 3.1 …`). Otherwise the spec launcher
  mistakes it for a batch and files it.
- Every batch needs these three lines: `- **Execution Mode**: ...` / `- **Objective**: ...` /
  `- **Verify**: ...`. A batch without `Execution Mode` gets no behaviour contract
  (`[Hermes Pilot Execution Contract]`) injected at filing time, so autonomy is not guaranteed.
- An optional `- **Recommended Role**: role:planner | role:builder | role:visual-reviewer` line may sit
  right after `Execution Mode` (design-heavy → `role:planner`, implement and verify → `role:builder`,
  include visual sign-off → `role:visual-reviewer`). Filing still works when it is absent.

## Choosing the Execution Mode

| Mode | When | Contract injected into the worker |
|---|---|---|
| `Zero-Stop` | The answer is unique (tests, build, mechanical refactor) | No questions; self-repair until the target repository's verification command passes, then `done` |
| `Fast-Track Review` | The approach is not settled and may branch mid-way | On a branch, file a `quick-review` sheet before implementing and wait for one-tap approval |
| `Visual Gate` | The look changes (UI, CSS, wording, layout) | Rebuild/deploy the target app → check and capture the declared screen sizes → `annotation` review when needed |

When in doubt use `Visual Gate`. If you cannot claim the look is unchanged, insert a visual check.

## Abstract roles, delegation and fallback (model-agnostic)

This skill is **model-agnostic**. Never write a specific model name, provider name, pricing plan or
personal path here. "Which abstract role maps to which real model, and where to fall back on failure"
is owned by the **device profile** (profile memory / the assignment table in `SOUL.md`). Specs and
skills deal in abstract role names only.

### The four abstract roles

- `role:planner` — heavy reasoning, design, spec authoring, complex root-causing. Round 1 question
  design; Round 2 impact analysis and batch breakdown.
- `role:builder` — routine implementation, test fixes, builds, mechanical work. Implementing the SPEC
  and repairing tests / the target repository's verification command.
- `role:visual-reviewer` — reading screenshot diffs and redlined images (`.annotated.png`), visual
  sign-off at the screen sizes the target repository declares (its SPEC **Verify** section or design rules). **Only when the visual comparison is the question.**
- `role:decision-framer` — question design and trade-off framing: cutting to 3±1 questions and
  composing options with the reason to recommend.

How to apply them:

- Round 1 / Round 2 design reasoning, impact analysis and batch breakdown → **`role:planner`**.
- Only when judging pictures (mocks, screenshots) **also use `role:visual-reviewer`**. Do not attach it
  to non-visual questions (API, storage format, naming, logic).
- Each batch definition may carry the optional `- **Recommended Role**: role:builder` line
  (`role:planner` / `role:visual-reviewer` / `role:decision-framer` likewise). Without it the role is
  inferred from the Execution Mode.

### Native delegation and fallback

Use only Hermes Agent's standard **`delegate_task`** for delegation.

1. The parent cuts a sub-task that matches a role and delegates once, naming the role in `goal` / `context`.
2. Children are **read-only advisers**. File edits, commits, installs and running the verification command are the parent's.
3. If delegation fails (error / rate limit / timeout / unsupported model / no delegation tool),
   **do not stop**. Switch to the fallback order in the profile assignment table (next choice → main model)
   and finish on your own.
4. Record the fallback in one line of the completion report or a comment (never silently drop verification).
5. If the same role fails twice, do not send a third attempt. Finish it yourself.

### Hard boundary: no external AI CLIs

**Do not spawn external AI CLIs such as the `gemini` CLI (`gemini -p`, …) or `agy -p` to do the
reasoning.** Launching them through `spawn` / `execFile` / `exec`, or piping from a shell, is also
covered. Use the Hermes native API provider plus `delegate_task` only.

## Sizing the batches

- One batch = a change **that closes within a single verification pass** (roughly 200-600 lines).
- Dependencies run one way, front to back. If `V5-2` uses an API from `V5-1`, put `V5-1` first.
- Order it "foundation → features → polish → end-to-end verification", and make the last batch the
  integration check plus a real-screen audit.
- **Fast intermediate Verify**: for intermediate batches (`1 .. N-1`), set **Verify** to targeted unit tests
  plus fast static/build/coherence checks (reserve slow headless-browser/real-screen audits and cold-install
  suites for the final batch `N`, unless an intermediate batch specifically changes UI layout or packaging).
- More than six batches: split into independent SPECs (one SPEC = one purpose).

### Round 2 self-check (before wrap-up)

- **Guard scope**: if the SPEC introduces or widens a static/coherence guard, verify its scope against existing files so unrelated modules (e.g. separate DB readers) are not falsely flagged, and align the guard description in the design section with the batch's Verify section.
- **Line-count baselines**: if any batch shrinks or modifies files tracked by the target repository's line-count baseline/ratchet, explicitly include updating that baseline in the batch steps so checks remain green.
- **Sequential order**: batches are filed in order, so confirm every batch only depends on earlier batches (`1 -> 2 -> ... -> N`).

## Wrap-up (A2B handoff)

After writing the SPEC, emit exactly one of these:

```text
Spec: docs/SPEC-<SLUG>.md (Batch <SLUG>-1 .. <SLUG>-N / n batches)
File it: hermes-pilot Tasks → spec launcher, or `specs.launchSpec` from your scripts (dryRun: true first, then run)
```

If the request was tagged `autoStart=true`, file the unfiled batches **exactly once**
(`dryRun: true` → `dryRun: false`; never create duplicates).

## Pitfalls

- **Do not hand-write HTML or shoot with a headless browser in Round 1.** Unless the visual comparison is
  the question, file one `.json` and block immediately (HTML and mock images burn minutes without
  changing the decision). Pictures are only for placement / density / colour comparisons.
- **`docs/SPEC-*.md` file names start with uppercase `SPEC`.** `spec-*.md` is not scanned.
- `BATCH_ID_RE` allows 16 characters. Longer ids (`V5-1-optimizer`) are truncated.
- Any `### ` heading in the body becomes a batch boundary at filing time. **Make sub-headings inside a
  batch `####` or deeper.**
- The `- **Execution Mode**` / `[Mode: ...]` notation must match the `specs.js` regex
  (`- **Execution Mode**: \`[Mode: Zero-Stop]\``). Backticks are optional.
- **Never put credentials, tokens or personal data in a spec.** Write paths as `~` or relative.
- Do not start writing the SPEC before the interview answers arrive. Work on other tasks while waiting.
