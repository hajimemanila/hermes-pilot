---
name: quick-review
description: "Ask a human to decide between options: build a Quick Review sheet, file a blocked [review] task, then apply the answer."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [review, human-in-the-loop, kanban, sheet]
    category: workflow
    phase: decide
    role: author
    abstract_roles: [role:decision-framer, role:planner, role:visual-reviewer]
    recommended_role: role:decision-framer
    quality_tier: decision-ready
---

# Quick Review (get a decision from one sheet)

When you reach a fork in implementation or investigation and **a human should decide**, do not
ask in long chat messages. Put the options and one recommendation on a single sheet and let them
answer with one tap. The answer comes back as a kanban `comment` + `unblock`, and the worker
resumes on its own.

This skill ships with the **`hermes-pilot` plugin**. `hermes-pilot init` installs it into both
`~/.hermes/skills/quick-review/` and `~/.hermes/profiles/<pilot>/skills/quick-review/`. Data lives in
`~/.hermes/plugin-data/hermes-pilot/review/` (override with `HP_DATA_DIR`).

## Language

Write user-facing prose in the run's UI language — sheet title/topic/question/option text, SPEC prose, and the comments and summaries you post.
Keep machine tokens ASCII and unchanged: `label=`, `sheet=`, `mode=`, `round=`, `target=`, task ids, file paths, and the SPEC keys **Execution Mode** / **Objective** / **Files** / **Verify**.
This matches the bridge prompt language rule: when the run's language is Japanese, only the prose switches to Japanese; the machine line and paths stay ASCII.
The rule covers the sheet you write and every prose line you post to the board, including the 1-line `complete --summary`.

## When to use it / when not to

Use it:
- Judgements where **the right answer is not unique** (look, layout, wording)
- Two or more implementation approaches that both work
- Before a destructive or irreversible action, to pin down the human's intent

Do not use it (decide yourself and proceed):
- The answer is unique (tests pass or fail, type error, one exclusive option)
- A fact check settles it (reading `file:line` is enough)
- Bulk sign-off of many items (stuffing them on one sheet makes it unanswerable)

## Abstract roles, delegation and fallback (model-agnostic)

This skill is **model-agnostic**. Never write a specific model name, provider name, pricing plan
or personal path here. "Which abstract role maps to which real model" is owned by the device
profile (profile memory / the assignment table in `SOUL.md`).

- `role:decision-framer` — question design and trade-off framing. **The primary role for this skill.**
  Cutting the decision into 3±1 questions, 2–3 options each, with the reason to recommend (gain / cost).
- `role:planner` — extracting options and comparing trade-offs for complex design forks.
- `role:visual-reviewer` — judging comparison thumbnails (`thumbs/*.png`). Only when a picture is attached.
- `role:builder` — applying the answer and running the verification command the target repository declares.

### Native delegation and fallback

1. Sub-tasks that match those roles **may be delegated with `delegate_task`** (name the role in
   `goal` / `context` and ask for "a result that drops straight into the question JSON").
2. Children are **read-only advisers**. Creating the sheet, filing the task and applying the answer are the parent's job.
3. If delegation fails (error / rate limit / timeout / unsupported model / no delegation tool),
   **do not stop**. Fall back to the main model and finish the question JSON yourself.
   Blocking without a sheet is the worst outcome — fall back and always ship one sheet.
4. Leave one line in a `comment` recording that you fell back.

### Hard boundary: no external AI CLIs

Do not spawn external AI CLIs such as the `gemini` CLI (`gemini -p`, …) or `agy -p` to draft
questions or thumbnails (this covers `spawn` / `execFile` / `exec`). Use the Hermes native
API provider plus `delegate_task` only.

## Procedure

### 1. Cut the questions down to 3±1

Each question is "one thing a human decides". **State the facts (`file:line` or command output) in the
body and leave only the decision to the human.** Two or three options. Pick one recommendation and
always give the reason (gain / cost).

### 2. Draw it (optional, only for visual questions)

Only when **the comparison itself** is the question (look, placement, information density, colour) draw
both options. If you are changing an existing screen, first capture a faithful shot of the current UI
(never a mock that drifts from the real thing). Do not attach pictures to non-visual questions
(naming, storage format, API, logic) — skipping them is faster and keeps the decision stable.
Use a headless browser only when a screenshot is required.

### 3. Build the sheet (JSON first, HTML optional)

**The first choice is one structured JSON sheet (`mode=standard`).** The PWA renders a native form from it.
`.html` is an **optional extension** for multi-tab comparisons, diagrams or side-by-side screenshots.

Location: `~/.hermes/plugin-data/hermes-pilot/review/sheets/<label>-<round>.json`
(`mkdir -p` first. `<label>` must match `^[a-z0-9][a-z0-9._-]{0,40}$`)

```json
{
  "label": "cockpit-03",
  "round": 1,
  "mode": "standard",
  "title": "Sheet title (the task title is fine)",
  "topic": "What is being decided, in one or two sentences",
  "target": "~/Projects/your-repo",
  "questions": [
    {
      "id": "q1",
      "text": "The question",
      "options": [
        { "id": "A", "label": "Option", "detail": "Gain: … / Cost: …", "recommended": true, "thumb": "thumbs/cockpit-03-1/q1-A.png" },
        { "id": "B", "label": "Option", "detail": "Gain: … / Cost: …" }
      ]
    }
  ],
  "has_global_note": true,
  "sheet": "sheets/cockpit-03-1.json",
  "created_at": "2026-11-13"
}
```

If you attach a picture, put it at `review/thumbs/<label>-<round>/q1-A.png` and make `thumb` a path
relative to `thumbs/...`.

Only when you also use `.html`, copy this skill's `assets/sheet-template.html` and replace the content.
The bridge reads exactly three things, so **do not change the structure** (not needed when you file with `.json` alone):

- `#akForm` … root of the question form
- `#out` … output target for the answer text (`textarea`)
- `#genBtn` … button that assembles the answer text (in the app it becomes "Send answer")

Question markup when you do write HTML (the bridge injection script decorates `#akForm .q h3`):

```html
<section class="q" data-q="q1">
  <h3>Q1. Which shape should the strip take: scrolling, static, or as-is?</h3>
  <label data-opt="A"><input type="radio" name="q1" value="A"> A. Scrolling ticker <span class="rec">Recommended</span>
    <span class="d">Gain: long titles stay readable to the end / Cost: eyes must keep tracking moving text</span></label>
  <label data-opt="B"><input type="radio" name="q1" value="B"> B. Static single line
    <span class="d">Gain: no fatigue / Cost: the second item onward is cut</span></label>
  <textarea name="note-q1" placeholder="Note (optional)"></textarea>
</section>
```

> The older procedure (`.html` first, `mode=sheet`) remains as **legacy / custom HTML extension**.
> In either `mode`, as long as the `.json` exists the PWA answers through `<StandardForm>`,
> and when `.html` is missing the bridge generates safe HTML from the `.json`.

### 4. File the task and set it `blocked`

The **machine-readable line** in the body (this single line is the bridge's only handle):

```text
[review] label=<label> round=<round> mode=standard sheet=sheets/<label>-<round>.json target=<repo_path> chat=<session_id>
```

```bash
hermes kanban --board <board> create "Q1-Q3: <title>" --idempotency-key "review:<label>:round-<round>" --body "$(cat <<'BODY'
<Human-facing summary: what unblocks the work, what is stuck right now>

[review] label=cockpit-03 round=1 mode=standard sheet=sheets/cockpit-03-1.json target=~/Projects/your-repo chat=<session_id>
BODY
)" --assignee <profile>

hermes kanban block <task_id> "Waiting for review (Q1-Q3)" --kind needs_input
```

- `target=` may be an absolute path after `~` expansion or `~/...` (the bridge resolves it)
- `chat=<session_id>` sends the completion report back to that conversation (otherwise feed only)
- **Always set `assignee`** (without it the dispatcher ignores the task)
- After filing, **wait**. Work on another task until the answer arrives (never invent an answer)

### 5. Apply the answer

Answers arrive one of two ways:

1. The PWA review screen → `POST /api/review/<task_id>/answer`
   → writes `review/sheets/<label>-<round>.answer.json` and `.answer.txt`, then `comment` + `unblock`s the task
2. Answer text pasted into the task comments (`[Review Answer]` format)

Read `.answer.txt` (or the comment) and **implement exactly the chosen options**.
`(unselected = take recommended)` may be settled with the recommendation. Instructions in
`Overall Note:` take priority. After applying, leave
`hermes kanban comment <task_id> "Applied: <what changed>"` and move on. If you judge the answer
differently, ask again with `POST /api/review/<task_id>/reopen` (`request-changes`).

## Answer format (do not break it)

The sheet generates this shape. The bridge's `parseReplyText` reads `[Review Answer]` and
`Overall Note:`, and still accepts the legacy `【レビュー回答】` / `全体へのコメント:`.

```text
[Review Answer] cockpit-03
Q1. Which shape should the strip take: scrolling, static, or as-is?: A - Scrolling ticker / note: up to 3 items is fine
Q2. Replace the existing bar?: (unselected = take recommended)
Overall Note: keep the current colours
---
Apply the answers above and continue. Items left unselected are settled by the recommended option.
```

## Pitfalls

- **`sheet=` is relative to `review/`** (`sheets/x-1.json`). `..` and absolute paths are rejected
- Prefer the machine line **`mode=standard sheet=sheets/<label>-<round>.json`**
  (only when you also use `.html`, write `mode=sheet sheet=sheets/x-1.html`). Writing `.html` in
  `image=` is rescued as a `sheet`, but write `sheet=` correctly
- **Do not hand-write `.html` or shoot with a headless browser when the question is not visual.**
  Attaching pictures to a question a single JSON settles costs minutes per sheet and delays the answer
- Re-sending the same answer is idempotent (decided by `sha256` in `.answer.json`). No double `comment`
- Answers are accepted **only while `blocked`**. Sending to `ready` / `running` / `done` returns 409 `NOT_WAITING`
- A second round uses `round=2` and **new files** (`<label>-2.json` / `.html`); never overwrite round 1
