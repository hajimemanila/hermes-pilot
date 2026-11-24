---
name: annotation
description: "Fix UI from a hand-drawn red-mark screenshot: file an [review] annotation task, read marks/note, apply the change."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [review, annotation, screenshot, ui, human-in-the-loop]
    category: workflow
    phase: fix
    role: author
    abstract_roles: [role:visual-reviewer, role:builder]
    recommended_role: role:visual-reviewer
    quality_tier: evidence-based
---

# Annotation (take UI corrections as red marks on a screenshot)

Post-implementation UI checks arrive as **red marks on an image**, not as prose complaints.
The human draws lines, boxes and arrows on a screenshot plus a short note, and the app turns that
into a `.annotation.json` with coordinates (`marks` + `note`). The agent reads it and **fixes exactly
the place that was pointed at**.

This skill ships with the **`hermes-pilot` plugin**. `hermes-pilot init` installs it into both
`~/.hermes/skills/annotation/` and `~/.hermes/profiles/<pilot>/skills/annotation/`. Data lives in
`~/.hermes/plugin-data/hermes-pilot/review/` (override with `HP_DATA_DIR`).

## Language

Write user-facing prose in the run's UI language — sheet title/topic/question/option text, SPEC prose, and the comments and summaries you post.
Keep machine tokens ASCII and unchanged: `label=`, `sheet=`, `mode=`, `round=`, `target=`, task ids, file paths, and the SPEC keys **Execution Mode** / **Objective** / **Files** / **Verify**.
This matches the bridge prompt language rule: when the run's language is Japanese, only the prose switches to Japanese; the machine line and paths stay ASCII.
The rule covers the sheet you write and every prose line you post to the board, including the 1-line `complete --summary`.

## When to use it

- You want a human eye to settle the look after implementation (spacing, wrapping, colour, overlap)
- Explaining it in prose would be long or ambiguous ("here" means nothing)
- Redlining a UI screenshot is the shortest path (a capture already exists)

Do not use it: fix unique defects yourself (failing test, exception, type error).

## Abstract roles, delegation and fallback (model-agnostic)

This skill is **model-agnostic**. Never write a specific model name, provider name, pricing plan
or personal path here. "Which abstract role maps to which real model" is owned by the device
profile (profile memory / the assignment table in `SOUL.md`).

- `role:visual-reviewer` — a separate lane from implementation. Reading screenshot diffs
  (`.before.png` / `.after.png`) and redlined images (`.annotated.png`), turning coordinates into
  words, and visual sign-off at the screen sizes the target repository declares (its SPEC **Verify** section or design rules). **The primary role for this skill.**
- `role:builder` — implementing the fix at the identified spot, rebuilding/deploying the target app, and running its declared verification command.
- `role:decision-framer` — question design when "how far do we fix" branches (hand off to `quick-review`).
- `role:planner` — when the red marks span several components or states and root-causing is complex.

### Native delegation and fallback

1. Reading the image in step B is best **delegated to `role:visual-reviewer` via `delegate_task`**.
   Pass image paths in `images`, and name the role plus "return the pointed region name and the evidence" in `goal` / `context`.
2. Children are **read-only advisers**. They do not edit files, commit, or rebuild/deploy the app.
   Applying and verifying is the parent's job (`role:builder`).
3. If delegation fails (error / rate limit / timeout / no multimodal / no delegation tool),
   **do not stop**. Identify the spot yourself from the `marks` coordinate array (0–1 normalised) and
   `note` in `.annotation.json`, and finish the fix. Coordinates substitute for reading the image.
4. Leave one line in a `comment` recording that you fell back.

### Hard boundary: no external AI CLIs

Do not spawn external AI CLIs such as the `gemini` CLI (`gemini -p`, …) or `agy -p` to read images
(this covers `spawn` / `execFile` / `exec`). Use the Hermes native API provider plus
`delegate_task` only.

## Path A: file the annotation task yourself (the screenshot side)

### 1. Capture (only for changes that alter the UI)

- Rebuild/deploy the target app **first** so you capture the updated screen rather than stale assets
- Capture the target app UI at the viewport sizes declared by the target repository (mobile/tablet sizes from its SPEC **Verify** section or design rules)
- Location: `~/.hermes/plugin-data/hermes-pilot/review/shots/<label>-<round>.png`
- To compare before and after, keep both `.before.png` and `.after.png`

### 2. File the task and set it `blocked`

The machine-readable line in the body:

```text
[review] label=<label> round=<round> mode=annotation image=shots/<label>-<round>.png target=<repo_path> chat=<session_id>
```

```bash
hermes kanban --board <board> create "Annotation: <what to look at>" --body "$(cat <<'BODY'
What to look at (1-3 items). Which screen, which state.

[review] label=tasks-strip round=1 mode=annotation image=shots/tasks-strip-1.png target=~/Projects/your-repo chat=<session_id>
BODY
)" --assignee <profile>

hermes kanban block <task_id> "Waiting for red marks" --kind needs_input
```

- `image=` is relative to `review/` (`shots/...`). `..` and absolute paths are rejected
- `assignee` is mandatory (without it the dispatcher ignores the task)
- Filing from the PWA: Review tab → [+ Annotation] → pick an image → send
  (`POST /api/review/annotation/new`; the bridge assembles the body and `chat=`)

### 3. Wait

Work on another task until the red marks arrive. Never invent red marks yourself.

## Path B: receive the red marks and fix

Saved artefacts (under `review/shots/`):

| File | Content |
|---|---|
| `<label>-<r>.png` | Base image (the original screenshot) |
| `<label>-<r>.annotated.png` | Composite with the red marks (**read this to see what the human pointed at**) |
| `<label>-<r>.annotation.json` | `{ note, marks: [{tool, points}], base_image, annotated_image, base_sha256, image_sha256, annotated_at }` |

`marks[].points` are **% of the base image width and height (0–1)**, and `tool` is `pen` / `rect` /
`arrow`, so map a coordinate back to a screen position with `x * width`, `y * height`.

1. Read `note` in `.annotation.json` (one line; the intent lives there)
2. Read `annotated.png` **delegated to `role:visual-reviewer` via `delegate_task`**
   (put `annotated.png` plus `before` / `after` in `images` and have it return the region, the
   component and the evidence). If delegation is unavailable you can work from the `marks`
   coordinates alone — **fall back to coordinates instead of stopping**
3. Map the red region to a component (DOM: `document.elementFromPoint`; React: `rg` the CSS/JSX)
4. Fix **only the pointed spot**. Do not mix in drive-by improvements around it (the diff stops being reviewable)
5. Rebuild/deploy the target app → re-capture and keep an after shot, then run the target repository's verification command (all `role:builder` work, i.e. the parent)
6. Leave `hermes kanban comment <task_id> "Applied: <which file, what changed>"`

Red marks are stored through `POST /api/review/<task_id>/annotation`
(`{annotated_image: "data:image/png;base64,…", marks, note}`), which also `comment` + `unblock`s the task.
Re-sending the same image is idempotent (`image_sha256`).

## Pitfalls

- **Answers are accepted only while `blocked`**. Sending to `ready` / `running` / `done` returns 409 `NOT_WAITING`
- Images up to 12 MB (data URL). Downscale before sending if larger
- `marks` is capped at 200 and `points` at 400 per stroke (the rest is dropped)
- `annotated_image` in `.annotation.json` is a **relative path**; the bridge resolves it under `review/`
- Coordinates are relative to the **base image**. Scaling the composite does not change ratios, but once
  you re-capture and the base changes, **old marks no longer apply** (file a new round)
- When copying images use `preserveTimestamps: true` (lists sort by `mtime`, newest first)
