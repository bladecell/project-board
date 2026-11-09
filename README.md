# project-board

Local kanban board for a project. Cards are markdown files, so agents and humans share one source of truth. Bun only, no dependencies, no build step.

## Install
One command, any machine with git (installs bun if missing, clones to `~/.local/share/project-board`, links `board`). Re-run it to update.

```sh
curl -fsSL https://raw.githubusercontent.com/bladecell/project-board/master/install.sh | bash
```

Then add `~/.bun/bin` to PATH if the installer says so (`fish_add_path ~/.bun/bin` on fish). Manual install: clone the repo and run `bun link` in it.

## Use

```sh
board init                      # create the board dir, update .gitignore, append workflow to CLAUDE.md (if it exists)
board                           # start the web board on http://127.0.0.1:4747 and open the browser
board add "title" --type bug --task P2.3 --phase P2 --lane fw --needs-you [--column todo] [--blocked]
board move 7 verify --notes "ran tests, all green" --steps "- [ ] flash and watch the log"
board steps 7 --steps "- [ ] one\n- [ ] two"   # append to How to verify (or pipe on stdin); duplicates skipped
board list [column]             # one line per card; done is hidden unless named
board show 7
board start 7 [--session label] # todo (or verify) -> in-progress, and mark an agent as working on it; inbox/planned/done refused
board stop 7                    # clear the marker
board mcp                       # stdio MCP server for agents; board mcp-config prints the client config
board subtasks 7                # plain list items in the description become - [ ] subtasks (idempotent)
```

`board show` also lists the git commits linked to a card. Links are computed live from `git log` (last 2000 commits, nothing stored in the card): a commit subject containing the card's `taskId` or `#<id>` as a whole token (`P2.3` does not match `P2.30` or `P2.3b`). No git repo means no commits. The web UI shows a commit count on the card and the list in the card panel (`GET /api/cards/:id` returns `commits`; the list endpoint returns `commitCount`).

Card text renders as markdown in the card panel (headings, lists, task checkboxes, code, quotes, links, `images/` images; raw HTML is never rendered, only http/https/mailto links). Edit switches a field to its textarea. `- [ ]` / `- [x]` items are tick boxes in all three fields; ticking writes the exact source line and only bumps `updated`. Cards show a `done/total` chip (description plus how to verify), and "Lists → subtasks" in the card panel converts a plain list. The renderer is `public/markdown.js`.

Options: `--dir <project root>` (default cwd), `--port <n>`, `--no-open`.
The server binds 127.0.0.1 only. Drag cards between columns, paste screenshots into a card body, edit everything in the detail panel. The board reloads when files change. Drag and drop needs a mouse; on touch use the Column field in the card panel.

## Live agent indicator

A card shows "Claude working" with a pulsing dot while an agent holds it, and "Claude idle 12m" once its heartbeat is older than 5 minutes. The marker is `agent` and `agentAt` in the card frontmatter. `board start <id>` sets it (label from `--session`, else `CLAUDE_SESSION_ID`, else `claude`; first 8 characters kept) and adds a history line "agent started". A todo (or verify, for rework) card moves to in-progress first; inbox and planned cards (not approved) and done cards are refused. `board stop <id>` clears the marker and adds "agent stopped" without moving the card. The heartbeat, `board touch`, only rewrites `agentAt`: no `updated` bump, no history, at most one write per 5 s. It reads the Claude Code hook JSON on stdin (64 KB cap), matches `session_id` by its first 8 characters against cards' labels, prints nothing and always exits 0.

To keep the heartbeat fresh, add this to your Claude Code `settings.json` (user or project). Nothing edits it for you:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "board touch", "timeout": 5, "async": true }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "board touch", "timeout": 5, "async": true }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "board touch", "timeout": 5, "async": true }] }
    ]
  }
}
```

Start the card with `--session` set to the session id (or export `CLAUDE_SESSION_ID`), otherwise the label `claude` never matches a hook's `session_id`. `board init` refreshes the Board workflow block in CLAUDE.md between its markers, so older projects pick up the `start`/`stop` lines by running it again.

## Copy prompt

"Copy prompt" in the card panel, and a small copy button on todo and in-progress cards, puts a ready instruction on the clipboard for an agent session (card id and title only, never the card text; the agent reads the card through `board_show`). Without clipboard access a box opens to copy from. `board prompt <id>` prints the same text. The builder is `public/prompt.js`.

## MCP server (Claude Code, opencode, others)

`board mcp` is a stdio MCP server (newline-delimited JSON-RPC, no dependencies, tools only). Agents start it with the project as cwd; `--dir <root>` overrides.

Install it into a project (explicit opt-in, `board init` never does this):

```sh
board install-mcp                  # Claude Code: .mcp.json + enabledMcpjsonServers in .claude/settings.local.json
board install-mcp --hooks          # also the `board touch` heartbeat hooks (see Live agent indicator)
board install-mcp --shared         # write .claude/settings.json (committed) instead of settings.local.json
board install-mcp opencode         # opencode.json, opencode 2.x schema: mcp.servers.board
board install-mcp opencode --opencode-v1   # opencode 1.x schema: mcp.board
board install-mcp --dry-run        # print the resulting files, write nothing
```

It merges into existing files: other servers, keys, key order and other hooks are kept, hooks are never duplicated, and a second run changes nothing. Files must be plain JSON; with comments, trailing commas or invalid JSON it refuses and writes nothing. Writes are atomic. It warns if `board` is not on PATH. `board mcp-config claude|opencode|opencode-v1` only prints the JSON.

Manual checks go in How to verify as `- [ ]` lines, never in the verify notes (notes are what the agent ran and the result): `move_to_verify` takes an optional `howToVerify`, and `set_how_to_verify` appends steps to in-progress or verify cards (never deletes existing text, skips duplicates). Squeezed-together `- [ ]` items are split one per line, and notes keep their line breaks.

Tools: `board_list`, `board_show`, `next_card` (top todo card no live agent holds), `claim_card` (todo or in-progress to in-progress, sets the agent marker; refused if another live agent holds it), `move_to_verify` (in-progress to verify, notes required, clears the marker), `add_card` (inbox only), `add_note` (appends to verify notes), `release_card`. Rules enforced in the server: agents never move cards to done, planned or todo, never move a card out of inbox, cannot delete, and cannot edit title, type, phase, lane or flags of existing cards. History lines are tagged `mcp:<client name>`. Every tool call refreshes the heartbeat of the cards this server holds, so the live indicator works without hooks. `board init` writes the workflow block to AGENTS.md (opencode reads it) as well as CLAUDE.md.

Custom channel/push notifications are Claude Code only and are not implemented.

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
