# project-board

Local kanban board for a project. Cards are markdown files, so agents and humans share one source of truth. Bun only, no dependencies, no build step.

## Install

```sh
bun link        # puts `board` in ~/.bun/bin; make sure that is on PATH
```

## Use

```sh
board init                      # create the board dir, update .gitignore, append workflow to CLAUDE.md (if it exists)
board                           # start the web board on http://127.0.0.1:4747 and open the browser
board add "title" --type bug --task P2.3 --phase P2 --lane fw --needs-you [--column todo] [--blocked]
board move 7 verify --notes "ran tests, all green"
board list [column]             # one line per card; done is hidden unless named
board show 7
```

`board show` also lists the git commits linked to a card. Links are computed live from `git log` (last 2000 commits, nothing stored in the card): a commit subject containing the card's `taskId` or `#<id>` as a whole token (`P2.3` does not match `P2.30` or `P2.3b`). No git repo means no commits. The web UI shows a commit count on the card and the list in the card panel (`GET /api/cards/:id` returns `commits`; the list endpoint returns `commitCount`).

Options: `--dir <project root>` (default cwd), `--port <n>`, `--no-open`.
The server binds 127.0.0.1 only. Drag cards between columns, paste screenshots into a card body, edit everything in the detail panel. The board reloads when files change. Drag and drop needs a mouse; on touch use the Column field in the card panel.

## Data

`plan/board/` if the project has `plan/`, else `board/`. Gitignored by `board init`.

```
cards/0007-fix-iso-tp-bound.md
images/<name>.png
```

Columns: `inbox`, `planned`, `todo`, `in-progress`, `verify`, `done`. Blocked is a flag.

```md
---
column: verify
order: 2
type: bug            # bug | feature | task | decision
taskId: P2.3         # optional, as are phase and lane
phase: P2
lane: fw
created: 2026-11-09T21:40:12Z   # set by the tool, ISO UTC
updated: 2026-11-10T08:00:00Z   # bumped on any real change
needsYou: true
blocked: false
title: Fix ISO-TP bound
---

Free text markdown. Images: ![](images/abc.png)

## Verify notes
- 2026-11-09: ran tests, all green

## How to verify
- [ ] flash and watch the log

## History
- 2026-11-09T21:40:12Z · created · cli
- 2026-11-10T08:00:00Z · moved inbox → verify · ui
```

`created`, `updated` and `## History` are owned by the tool (the API ignores client values). History logs creation, moves, flag, type, title, phase, taskId and lane changes, and "verify notes updated"; the last field is the source, `ui` or `cli`. Description and checklist edits only bump `updated`. Capped at 200 lines. Cards without these fields get created/updated from file times on read and are written on their next real change.

Test: `bun test`.
