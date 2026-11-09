#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import {
  boardDir, boardRel, columns, convertSubtasks, createCard, hasBoard, initBoard, isAgentLive, loadCards, moveCard, serializeCard, sortCards, startAgent, stopAgent, touchAgents, types,
  type Card,
} from "./lib";
import { getCommits, linkCommits } from "./commits";
import { startServer } from "./server";
import { runStdio } from "./mcp";
import { installMcp, onPath } from "./installmcp";

const usage = `board                      start the web board in this project and open the browser
board init                 create the board dir, update .gitignore and CLAUDE.md
board add "title" [--type bug|feature|task|decision] [--column inbox] [--task P2.3] [--phase X] [--lane L] [--needs-you] [--blocked]
board move <id> <column> [--notes "what ran + result"]
board list [column]        one line per card (done is hidden unless asked for)
board show <id>
board start <id> [--session label]  mark an agent as working on the card (no column move)
board stop <id>            clear the agent marker
board touch                heartbeat for a Claude Code hook (reads hook JSON on stdin, silent)
board mcp                  stdio MCP server for agents (Claude Code, opencode, ...); run from the project dir or pass --dir
board mcp-config [claude|opencode|opencode-v1]  print the JSON to paste into .mcp.json or opencode.json
board install-mcp [claude|opencode] [--hooks] [--shared] [--dry-run] [--opencode-v1]
                           merge the board MCP server into the project's agent config (explicit opt-in)
board subtasks <id>         turn plain list items in the description into - [ ] subtasks
options: --dir <project root> (default cwd), --port <n> (default 4747), --no-open
columns: ${columns.join(", ")}`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    dir: { type: "string" }, port: { type: "string" }, "no-open": { type: "boolean" },
    type: { type: "string" }, column: { type: "string" }, task: { type: "string" }, phase: { type: "string" },
    lane: { type: "string" }, "needs-you": { type: "boolean" }, blocked: { type: "boolean" }, notes: { type: "string" }, session: { type: "string" }, hooks: { type: "boolean" }, shared: { type: "boolean" }, "dry-run": { type: "boolean" }, "opencode-v1": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
const [cmd, ...args] = positionals;
const findRoot = (from: string) => {
  for (let d = from; ; d = dirname(d)) {
    if (hasBoard(d)) return d;
    if (dirname(d) === d) return from;
  }
};
const root = values.dir !== undefined || cmd === "init" || cmd === "install-mcp" ? resolve(values.dir ?? process.cwd()) : findRoot(process.cwd());

const fail = (msg: string): never => { console.error(`board: ${msg}`); process.exit(1); };
const need = () => (hasBoard(root) ? boardDir(root) : fail("no board here. Run `board init` first."));
const cardId = (s: string | undefined) => {
  const id = /^\d+$/.test(s ?? "") ? Number(s) : NaN;
  return Number.isSafeInteger(id) ? id : fail(`invalid card id "${s}"`);
};
const column = (s: string) => (columns as readonly string[]).includes(s) ? s as (typeof columns)[number] : fail(`unknown column "${s}" (${columns.join(", ")})`);
const age = (iso: string) => {
  const m = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
const agentNote = (c: Card) => (c.agent ? `agent:${c.agent} ${isAgentLive(c) ? "live" : "idle"} ${c.agentAt ? age(c.agentAt) : ""}`.trim() : "");
const line = (c: Card) =>
  [String(c.id).padStart(4, "0"), c.column.padEnd(11), c.type.padEnd(8), (c.taskId || "-").padEnd(6),
    [c.needsYou && "needs-you", c.blocked && "blocked"].filter(Boolean).join(",") || "-", c.title, agentNote(c)].filter((p, i, a) => p || i < a.length - 1).join("  ");

// Hook heartbeat: bounded stdin, never blocks on a TTY, never prints, always exits 0.
async function touch() {
  try {
    if (process.stdin.isTTY || !hasBoard(root)) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = Bun.stdin.stream().getReader();
    const timer = setTimeout(() => reader.cancel().catch(() => {}), 2000);
    try {
      while (size <= 65536) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
      }
    } finally {
      clearTimeout(timer);
      reader.cancel().catch(() => {});
    }
    if (size > 65536) return;
    const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof j?.session_id === "string") touchAgents(boardDir(root), j.session_id);
  } catch {}
}

async function serve() {
  const dir = need();
  const port = values.port === undefined ? 4747 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid port "${values.port}"`);
  let server;
  try {
    server = startServer(dir, port, basename(root));
  } catch (e) {
    fail(`cannot listen on 127.0.0.1:${port} (${(e as Error).message}). Try --port.`);
  }
  const url = `http://127.0.0.1:${server!.port}/`;
  console.log(`board: ${url}  (${boardRel(root)}, Ctrl+C to stop)`);
  if (!values["no-open"]) {
    try { Bun.spawn(["xdg-open", url], { stdio: ["ignore", "ignore", "ignore"] }).unref(); } catch {}
  }
  process.on("SIGINT", () => { server!.close(); process.exit(0); });
  process.on("SIGTERM", () => { server!.close(); process.exit(0); });
}

try {
  if (values.help || cmd === "help") console.log(usage);
  else if (cmd === "touch") await touch();
  else if (cmd === "mcp") await runStdio(root);
  else if (cmd === "install-mcp") {
    const target = args[0] ?? "claude";
    if (target !== "claude" && target !== "opencode") fail("usage: board install-mcp [claude|opencode] [--hooks] [--shared] [--dry-run] [--opencode-v1]");
    const dry = !!values["dry-run"];
    const res = installMcp(root, { target: target as "claude" | "opencode", hooks: values.hooks, shared: values.shared, v1: values["opencode-v1"] }, dry);
    for (const r of res) {
      const rel = r.path.slice(root.length + 1);
      console.log(`${r.status === "unchanged" ? "already configured" : dry ? `would ${r.status === "created" ? "create" : "update"}` : r.status}: ${rel}`);
      if (dry && r.status !== "unchanged") console.log(`--- ${rel}\n${r.text}`);
    }
    if (!onPath("board")) console.error("warning: `board` is not on PATH; agents will not find the server until it is (bun link).");
    if (target === "claude" && res.some((r) => r.status !== "unchanged") && !dry) console.log("restart Claude Code in this project to load it");
  }
  else if (cmd === "mcp-config") {
    const which = args[0] ?? "claude";
    const cfg = which === "claude" ? { mcpServers: { board: { command: "board", args: ["mcp"] } } }
      : which === "opencode" ? { $schema: "https://opencode.ai/config.json", mcp: { servers: { board: { type: "local", command: ["board", "mcp"] } } } }
      : which === "opencode-v1" ? { $schema: "https://opencode.ai/config.json", mcp: { board: { type: "local", command: ["board", "mcp"], enabled: true } } }
      : fail("usage: board mcp-config [claude|opencode|opencode-v1]");
    console.log(JSON.stringify(cfg, null, 2));
    console.error(`# paste into ${which === "claude" ? ".mcp.json" : "opencode.json"} in the project root`);
  }
  else if (!cmd || cmd === "serve") await serve();
  else if (cmd === "init") {
    const r = initBoard(root);
    console.log(`board dir: ${r.dir}`);
    console.log(r.gitignore === "added" ? ".gitignore: added board path" : ".gitignore: already ignored");
    for (const [name, s] of [["CLAUDE.md", r.claude], ["AGENTS.md", r.agents]] as const) {
      console.log({ appended: `${name}: appended Board workflow block`, updated: `${name}: updated Board workflow block`, present: `${name}: block already present`, missing: `${name}: not found, no workflow block added` }[s]);
    }
    console.log("agent setup (optional): board install-mcp [claude|opencode] [--hooks]");
    console.log(`start it with: board${root === process.cwd() ? "" : ` --dir ${root}`}`);
  } else if (cmd === "add") {
    const title = args.join(" ").trim();
    if (!title) fail('usage: board add "title" [options]');
    if (values.type && !(types as readonly string[]).includes(values.type)) fail(`unknown type "${values.type}" (${types.join(", ")})`);
    const c = createCard(need(), {
      title, ...(values.type && { type: values.type }), ...(values.column && { column: column(values.column) }),
      ...(values.task && { taskId: values.task }), ...(values.phase && { phase: values.phase }), ...(values.lane && { lane: values.lane }),
      ...(values["needs-you"] && { needsYou: true }), ...(values.blocked && { blocked: true }),
    }, { by: "cli" });
    console.log(line(c));
  } else if (cmd === "move") {
    if (args.length < 2) fail("usage: board move <id> <column> [--notes ...]");
    console.log(line(moveCard(need(), cardId(args[0]), column(args[1]), null, values.notes, { by: "cli" })));
  } else if (cmd === "start") {
    const c = startAgent(need(), cardId(args[0]), values.session ?? (process.env.CLAUDE_SESSION_ID || "claude"), { by: "cli" });
    console.log(line(c));
  } else if (cmd === "stop") {
    console.log(line(stopAgent(need(), cardId(args[0]), { by: "cli" })));
  } else if (cmd === "list") {
    const col = args[0] ? column(args[0]) : null;
    const cards = sortCards(loadCards(need())).filter((c) => (col ? c.column === col : c.column !== "done"));
    console.log(cards.length ? cards.map(line).join("\n") : "(no cards)");
  } else if (cmd === "subtasks") {
    const dir = need();
    const id = cardId(args[0]);
    const before = loadCards(dir).find((x) => x.id === id) ?? fail(`no card ${id}`);
    const after = convertSubtasks(dir, id, { by: "cli" });
    console.log(after === before || after.description === before.description ? `${line(after)}\nnothing to convert` : `${line(after)}\nconverted list items to subtasks`);
  } else if (cmd === "show") {
    const dir = need();
    const id = cardId(args[0]);
    const c = loadCards(dir).find((x) => x.id === id) ?? fail(`no card ${id}`);
    console.log(`# ${join(dir, "cards", c.file)}\n${serializeCard(c)}`);
    if (c.agent) console.log(`\nAgent ${c.agent}: ${isAgentLive(c) ? "working" : "idle"}, last heartbeat ${c.agentAt ? `${age(c.agentAt)} ago` : "unknown"}`);
    const linked = linkCommits(await getCommits(dir), [c]).get(id) ?? [];
    if (linked.length) console.log(`\nCommits (${linked.length}${linked.length > 50 ? ", newest 50" : ""})\n${linked.slice(0, 50).map((k) => `${k.short}  ${k.at.slice(0, 10)}  ${k.subject}`).join("\n")}`);
  } else fail(`unknown command "${cmd}"\n${usage}`);
} catch (e) {
  fail((e as Error).message);
}
