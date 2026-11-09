#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { basename, join, resolve } from "node:path";
import {
  boardDir, boardRel, columns, createCard, hasBoard, initBoard, loadCards, moveCard, serializeCard, sortCards, types,
  type Card,
} from "./lib";
import { startServer } from "./server";

const usage = `board                      start the web board in this project and open the browser
board init                 create the board dir, update .gitignore and CLAUDE.md
board add "title" [--type bug|feature|task|decision] [--column inbox] [--task P2.3] [--phase X] [--lane L] [--needs-you] [--blocked]
board move <id> <column> [--notes "what ran + result"]
board list [column]        one line per card (done is hidden unless asked for)
board show <id>
options: --dir <project root> (default cwd), --port <n> (default 4747), --no-open
columns: ${columns.join(", ")}`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    dir: { type: "string" }, port: { type: "string" }, "no-open": { type: "boolean" },
    type: { type: "string" }, column: { type: "string" }, task: { type: "string" }, phase: { type: "string" },
    lane: { type: "string" }, "needs-you": { type: "boolean" }, blocked: { type: "boolean" }, notes: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const [cmd, ...args] = positionals;
const root = resolve(values.dir ?? process.cwd());

const fail = (msg: string): never => { console.error(`board: ${msg}`); process.exit(1); };
const need = () => (hasBoard(root) ? boardDir(root) : fail("no board here. Run `board init` first."));
const cardId = (s: string | undefined) => {
  const id = /^\d+$/.test(s ?? "") ? Number(s) : NaN;
  return Number.isSafeInteger(id) ? id : fail(`invalid card id "${s}"`);
};
const column = (s: string) => (columns as readonly string[]).includes(s) ? s as (typeof columns)[number] : fail(`unknown column "${s}" (${columns.join(", ")})`);
const line = (c: Card) =>
  [String(c.id).padStart(4, "0"), c.column.padEnd(11), c.type.padEnd(8), (c.taskId || "-").padEnd(6),
    [c.needsYou && "needs-you", c.blocked && "blocked"].filter(Boolean).join(",") || "-", c.title].join("  ");

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
  else if (!cmd || cmd === "serve") await serve();
  else if (cmd === "init") {
    const r = initBoard(root);
    console.log(`board dir: ${r.dir}`);
    console.log(r.gitignore === "added" ? ".gitignore: added board path" : ".gitignore: already ignored");
    console.log({ appended: "CLAUDE.md: appended Board workflow block", present: "CLAUDE.md: block already present", missing: "CLAUDE.md: not found, no workflow block added" }[r.claude]);
    console.log(`start it with: board${root === process.cwd() ? "" : ` --dir ${root}`}`);
  } else if (cmd === "add") {
    const title = args.join(" ").trim();
    if (!title) fail('usage: board add "title" [options]');
    if (values.type && !(types as readonly string[]).includes(values.type)) fail(`unknown type "${values.type}" (${types.join(", ")})`);
    const c = createCard(need(), {
      title, ...(values.type && { type: values.type }), ...(values.column && { column: column(values.column) }),
      ...(values.task && { taskId: values.task }), ...(values.phase && { phase: values.phase }), ...(values.lane && { lane: values.lane }),
      ...(values["needs-you"] && { needsYou: true }), ...(values.blocked && { blocked: true }),
    });
    console.log(line(c));
  } else if (cmd === "move") {
    if (args.length < 2) fail("usage: board move <id> <column> [--notes ...]");
    console.log(line(moveCard(need(), cardId(args[0]), column(args[1]), null, values.notes)));
  } else if (cmd === "list") {
    const col = args[0] ? column(args[0]) : null;
    const cards = sortCards(loadCards(need())).filter((c) => (col ? c.column === col : c.column !== "done"));
    console.log(cards.length ? cards.map(line).join("\n") : "(no cards)");
  } else if (cmd === "show") {
    const dir = need();
    const id = cardId(args[0]);
    const c = loadCards(dir).find((x) => x.id === id) ?? fail(`no card ${id}`);
    console.log(`# ${join(dir, "cards", c.file)}\n${serializeCard(c)}`);
  } else fail(`unknown command "${cmd}"\n${usage}`);
} catch (e) {
  fail((e as Error).message);
}
