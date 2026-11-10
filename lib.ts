import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { countTasks, listToTasks, splitInlineTasks } from "./public/markdown.js";

export const columns = ["inbox", "planned", "todo", "in-progress", "verify", "done"] as const;
export const types = ["bug", "feature", "task", "decision"] as const;
export type Column = (typeof columns)[number];
export type CardType = (typeof types)[number];

export type Source = "ui" | "cli" | `mcp:${string}`;
export type Ctx = { by: Source; now?: Date };
export type HistoryEntry = { at: string; text: string; by: Source };

export type Card = {
  id: number;
  file: string;
  column: Column;
  order: number;
  type: CardType;
  taskId: string;
  phase: string;
  lane: string;
  needsYou: boolean;
  blocked: boolean;
  title: string;
  description: string;
  verifyNotes: string;
  howToVerify: string;
  options: string[];
  multi: boolean;
  answer: string;
  created: string;
  updated: string;
  history: HistoryEntry[];
  agent: string;
  agentAt: string;
};

export type Patch = Partial<Omit<Card, "id" | "file" | "order" | "created" | "updated" | "history" | "agent" | "agentAt" | "answer">>;

const isColumn = (v: unknown): v is Column => columns.includes(v as Column);
const isType = (v: unknown): v is CardType => types.includes(v as CardType);
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export const idOf = (file: string) => {
  const m = /^(\d+)-.*\.md$/.exec(file);
  return m ? Number(m[1]) : null;
};

export const slugify = (title: string) =>
  title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "card";

export const fileName = (id: number, title: string) => `${String(id).padStart(4, "0")}-${slugify(title)}.md`;

const sections = { "verify notes": "verifyNotes", "how to verify": "howToVerify", options: "options", answer: "answer", history: "history" } as const;
export const maxOptions = 12;
export const maxOptionLen = 200;
const sectionRe = "verify notes|how to verify|options|answer|history";
const maxHistory = 200;
const maxEventText = 160;
const isoRe = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/;
const validIso = (v: string | undefined) => (v && isoRe.test(v) && Number.isFinite(Date.parse(v)) ? v : "");
export const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const cut = (s: string) => (s.length > maxEventText ? `${s.slice(0, maxEventText - 1)}…` : s);

export function parseHistoryLine(l: string): HistoryEntry | null {
  const m = /^- (\d{4}-\d\d-\d\dT[\d:.]+Z) · (.+) · (ui|cli|mcp:[A-Za-z0-9._-]{1,40})\s*$/.exec(l);
  return m ? { at: m[1], text: m[2], by: m[3] as Source } : null;
}

export function parseCard(file: string, text: string): Card | null {
  const id = idOf(file);
  if (id === null) return null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const meta: Record<string, string> = {};
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const i = l.indexOf(":");
        if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim();
      }
      bodyStart = end + 1;
    }
  }
  const parts = { description: [] as string[], verifyNotes: [] as string[], howToVerify: [] as string[], options: [] as string[], answer: [] as string[], history: [] as string[] };
  let cur: keyof typeof parts = "description";
  for (const l of lines.slice(bodyStart)) {
    const m = new RegExp(`^##\\s+(${sectionRe})\\s*$`, "i").exec(l);
    if (m) cur = sections[m[1].toLowerCase() as keyof typeof sections];
    else parts[cur].push(l);
  }
  const order = Number(meta.order);
  return {
    id,
    file,
    column: isColumn(meta.column) ? meta.column : "inbox",
    order: Number.isFinite(order) && meta.order !== "" && meta.order !== undefined ? order : 0,
    type: isType(meta.type) ? meta.type : "task",
    taskId: meta.taskId ?? "",
    phase: meta.phase ?? "",
    lane: meta.lane ?? "",
    needsYou: meta.needsYou === "true",
    blocked: meta.blocked === "true",
    title: meta.title || file.replace(/^\d+-|\.md$/g, "") || "untitled",
    description: parts.description.join("\n").trim(),
    verifyNotes: parts.verifyNotes.join("\n").trim(),
    howToVerify: parts.howToVerify.join("\n").trim(),
    options: parts.options.flatMap((l) => { const m = /^- (.+)$/.exec(l); return m ? [oneLine(m[1]).slice(0, maxOptionLen)] : []; }).slice(0, maxOptions),
    multi: meta.multi === "true",
    answer: parts.answer.join("\n").trim(),
    created: validIso(meta.created),
    updated: validIso(meta.updated),
    history: parts.history.flatMap((l) => parseHistoryLine(l) ?? []).slice(-maxHistory),
    agent: oneLine(meta.agent ?? "").slice(0, 40),
    agentAt: meta.agent ? validIso(meta.agentAt) : "",
  };
}

export function serializeCard(c: Card): string {
  const head = [`column: ${c.column}`, `order: ${c.order}`, `type: ${c.type}`];
  if (c.taskId) head.push(`taskId: ${oneLine(c.taskId)}`);
  if (c.phase) head.push(`phase: ${oneLine(c.phase)}`);
  if (c.lane) head.push(`lane: ${oneLine(c.lane)}`);
  if (c.created) head.push(`created: ${c.created}`);
  if (c.updated) head.push(`updated: ${c.updated}`);
  if (c.agent) head.push(`agent: ${oneLine(c.agent)}`, ...(c.agentAt ? [`agentAt: ${c.agentAt}`] : []));
  if (c.multi) head.push("multi: true");
  head.push(`needsYou: ${c.needsYou}`, `blocked: ${c.blocked}`, `title: ${oneLine(c.title)}`);
  // a leading space keeps user text from being read back as a section heading
  const safe = (t: string) => t.trim().replace(new RegExp(`^(##\\s+(?:${sectionRe})\\s*)$`, "gim"), " $1");
  const body = [safe(c.description)];
  if (c.verifyNotes.trim()) body.push(`## Verify notes\n${safe(c.verifyNotes)}`);
  if (c.howToVerify.trim()) body.push(`## How to verify\n${safe(c.howToVerify)}`);
  if (c.options.length) body.push(`## Options\n${c.options.map((o) => `- ${oneLine(o)}`).join("\n")}`);
  if (c.answer.trim()) body.push(`## Answer\n${safe(c.answer)}`);
  if (c.history.length) body.push(`## History\n${c.history.slice(-maxHistory).map((h) => `- ${h.at} · ${cut(oneLine(h.text))} · ${h.by}`).join("\n")}`);
  return `---\n${head.join("\n")}\n---\n\n${body.filter(Boolean).join("\n\n")}\n`;
}

export const nextId = (cards: Card[]) => cards.reduce((m, c) => Math.max(m, c.id), 0) + 1;
export const endOrder = (cards: Card[], column: Column) =>
  cards.filter((c) => c.column === column).reduce((m, c) => Math.max(m, c.order), 0) + 1;

export const sortCards = (cards: Card[]) =>
  [...cards].sort((a, b) => columns.indexOf(a.column) - columns.indexOf(b.column) || a.order - b.order || a.id - b.id);

// Returns only the cards whose column or order changed. Target column is renumbered 1..n.
export function placeCard(cards: Card[], id: number, column: Column, beforeId: number | null = null): Card[] {
  const moving = cards.find((c) => c.id === id);
  if (!moving) throw new Error(`no card ${id}`);
  const target = sortCards(cards.filter((c) => c.column === column && c.id !== id));
  const at = beforeId === null ? -1 : target.findIndex((c) => c.id === beforeId);
  const next = [...target];
  next.splice(at < 0 ? next.length : at, 0, { ...moving, column });
  return next.flatMap((c, i) => {
    const old = cards.find((o) => o.id === c.id)!;
    return old.order === i + 1 && old.column === column ? [] : [{ ...c, order: i + 1 }];
  });
}

// Notes keep their line breaks: continuation lines are indented so they can never read as a section heading.
export function appendNotes(c: Card, notes: string, date = new Date()): Card {
  const [first = "", ...rest] = splitInlineTasks(notes.replace(/\r\n?/g, "\n")).split("\n").map((l) => l.trimEnd()).filter((l, i, a) => l || a.slice(i + 1).some(Boolean));
  const line = [`- ${date.toISOString().slice(0, 10)}: ${first.trim()}`, ...rest.map((l) => (l ? `  ${l}` : ""))].join("\n");
  return { ...c, verifyNotes: c.verifyNotes ? `${c.verifyNotes}\n${line}` : line };
}

// Steps text from an agent or the CLI: real newlines, CRLF and a literal backslash-n all count; one tick box per line.
export const normalizeSteps = (s: string) =>
  splitInlineTasks(s.replace(/\r\n?/g, "\n").replace(/\\n/g, "\n")).split("\n").map((l) => l.trimEnd()).join("\n").trim();

const stepKey = (l: string) => l.trim().replace(/^([-*+]\s+)\[[xX]\]/, "$1[ ]");

// Appends steps that are not already present (compared by trimmed text, tick state ignored). Never removes anything.
export function addSteps(c: Card, steps: string): Card {
  const have = new Set(c.howToVerify.split("\n").map(stepKey));
  const fresh = normalizeSteps(steps).split("\n").filter((l) => l.trim() && !have.has(stepKey(l)) && have.add(stepKey(l)));
  if (!fresh.length) return c;
  const howToVerify = c.howToVerify ? `${c.howToVerify}\n${fresh.join("\n")}` : fresh.join("\n");
  return howToVerify.length > 100_000 ? c : { ...c, howToVerify };
}

export function setSteps(dir: string, id: number, steps: string, ctx: Ctx): Card {
  const old = loadCards(dir).find((c) => c.id === id);
  if (!old) throw new Error(`no card ${id}`);
  const next = addSteps(old, steps);
  const out = stamp(old, next, ctx, ["verify steps added"]);
  if (out !== next || next !== old) writeCard(dir, out);
  return out;
}

const str = (v: unknown, name: string, max: number) => {
  if (typeof v !== "string") throw new Error(`${name} must be a string`);
  if (v.length > max) throw new Error(`${name} too long`);
  return v;
};

export function cleanOptions(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error("options must be a list of strings");
  const out = v.map((o) => {
    if (typeof o !== "string") throw new Error("options must be a list of strings");
    const t = oneLine(o);
    if (t.length > maxOptionLen) throw new Error(`an option is longer than ${maxOptionLen} characters`);
    return t;
  }).filter(Boolean);
  const uniq = [...new Set(out)];
  if (uniq.length > maxOptions) throw new Error(`at most ${maxOptions} options`);
  return uniq;
}

export function applyPatch(c: Card, p: Record<string, unknown>): Card {
  const out = { ...c };
  if ("title" in p) {
    out.title = oneLine(str(p.title, "title", 200));
    if (!out.title) throw new Error("title required");
  }
  if ("column" in p) {
    if (!isColumn(p.column)) throw new Error("invalid column");
    out.column = p.column;
  }
  if ("type" in p) {
    if (!isType(p.type)) throw new Error("invalid type");
    out.type = p.type;
  }
  for (const k of ["taskId", "phase", "lane"] as const) if (k in p) out[k] = oneLine(str(p[k], k, 60));
  for (const k of ["needsYou", "blocked"] as const) {
    if (k in p) {
      if (typeof p[k] !== "boolean") throw new Error(`${k} must be boolean`);
      out[k] = p[k] as boolean;
    }
  }
  for (const k of ["description", "verifyNotes", "howToVerify"] as const) if (k in p) out[k] = str(p[k], k, 100_000);
  if ("options" in p) out.options = cleanOptions(p.options);
  if ("multi" in p) {
    if (typeof p.multi !== "boolean") throw new Error("multi must be boolean");
    out.multi = p.multi;
  }
  return out;
}

const material = ["column", "type", "taskId", "phase", "lane", "needsYou", "blocked", "title", "description", "verifyNotes", "howToVerify"] as const;
const none = (v: string) => v || "(none)";
// ticking a checkbox is not a notes edit: compare with every task mark normalised
const untick = (s: string) => s.replace(/^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[[xX]\]/gm, "$1[ ]");

export function taskCounts(c: Pick<Card, "description" | "howToVerify">) {
  const a = countTasks(c.description), b = countTasks(c.howToVerify);
  return { tasksDone: a.done + b.done, tasksTotal: a.total + b.total };
}

function diffEvents(a: Card, b: Card): string[] {
  const ev: string[] = [];
  if (a.column !== b.column) ev.push(`moved ${a.column} → ${b.column}`);
  for (const [k, label] of [["needsYou", "needs you"], ["blocked", "blocked"]] as const) {
    if (a[k] !== b[k]) ev.push(`${label} ${b[k] ? "set" : "cleared"}`);
  }
  if (a.type !== b.type) ev.push(`type ${a.type} → ${b.type}`);
  for (const k of ["title", "phase", "taskId", "lane"] as const) {
    if (a[k] !== b[k]) ev.push(`${k} ${none(a[k])} → ${none(b[k])}`);
  }
  if (untick(a.verifyNotes) !== untick(b.verifyNotes)) ev.push("verify notes updated");
  if (a.options.join("\n") !== b.options.join("\n") || a.multi !== b.multi) ev.push("options updated");
  if (a.answer !== b.answer) ev.push(b.answer ? "answered" : "answer cleared");
  return ev;
}

// Single place that owns created/updated/history. Returns `next` itself when nothing real changed.
export function stamp(old: Card | null, next: Card, ctx: Ctx, extra: string[] = []): Card {
  const at = iso(ctx.now ?? new Date());
  const entry = (text: string): HistoryEntry => ({ at, text: cut(oneLine(text)), by: ctx.by });
  if (!old) return { ...next, created: at, updated: at, history: [entry("created")] };
  if (!material.some((k) => old[k] !== next[k]) && old.options.join("\n") === next.options.join("\n") && old.multi === next.multi && old.answer === next.answer) return next;
  const events = [...diffEvents(old, next), ...extra];
  if (next.column !== "in-progress" && next.agent && old.column !== next.column) {
    next = { ...next, agent: "", agentAt: "" };
    events.push("agent stopped");
  }
  const history = [...old.history, ...events.map(entry)].slice(-maxHistory);
  return { ...next, created: old.created || at, updated: at, history };
}

export function atomicWrite(path: string, data: string | Uint8Array) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

export function boardDir(root: string) {
  for (const rel of ["plan/board", "board"]) if (isDir(join(root, rel))) return join(root, rel);
  return join(root, isDir(join(root, "plan")) ? "plan/board" : "board");
}

export const boardRel = (root: string) => boardDir(root).slice(root.length + 1);
export const hasBoard = (root: string) => isDir(join(boardDir(root), "cards"));

export function loadCards(dir: string): Card[] {
  const cardsDir = join(dir, "cards");
  if (!existsSync(cardsDir)) return [];
  return readdirSync(cardsDir).flatMap((f) => {
    try {
      const path = join(cardsDir, f);
      const c = parseCard(f, readFileSync(path, "utf8"));
      if (!c) return [];
      if (!c.created || !c.updated) {
        const st = statSync(path);
        c.updated ||= iso(st.mtime);
        c.created ||= iso(st.birthtimeMs > 0 ? st.birthtime : st.mtime);
      }
      return [c];
    } catch {
      return [];
    }
  });
}

export const writeCard = (dir: string, c: Card) => atomicWrite(join(dir, "cards", c.file), serializeCard(c));

export function createCard(dir: string, input: Record<string, unknown>, ctx: Ctx): Card {
  const cards = loadCards(dir);
  const id = nextId(cards);
  const base = applyPatch({
    id, file: "", column: "inbox", order: 0, type: "task", taskId: "", phase: "", lane: "",
    needsYou: false, blocked: false, title: "", description: "", verifyNotes: "", howToVerify: "", options: [], multi: false, answer: "",
    created: "", updated: "", history: [], agent: "", agentAt: "",
  }, input);
  if (!base.title) throw new Error("title required");
  const card = stamp(null, { ...base, file: fileName(id, base.title), order: endOrder(cards, base.column) }, ctx);
  writeCard(dir, card);
  return card;
}

export function updateCard(dir: string, id: number, patch: Record<string, unknown>, ctx: Ctx): Card {
  const cards = loadCards(dir);
  const old = cards.find((c) => c.id === id);
  if (!old) throw new Error(`no card ${id}`);
  const next = applyPatch(old, patch);
  const out = stamp(old, next, ctx);
  if (out !== next) writeCard(dir, out);
  return out;
}

export function moveCard(dir: string, id: number, column: Column, beforeId: number | null, notes: string | undefined, ctx: Ctx, steps?: string): Card {
  const cards = loadCards(dir);
  const old = cards.find((c) => c.id === id);
  if (!old) throw new Error(`no card ${id}`);
  const changed = placeCard(cards, id, column, beforeId);
  let moved = changed.find((c) => c.id === id) ?? old;
  if (notes) moved = appendNotes(moved, notes);
  const extra: string[] = [];
  if (steps) {
    const s = addSteps(moved, steps);
    if (s !== moved) { moved = s; extra.push("verify steps added"); }
  }
  const out = stamp(old, moved, ctx, extra);
  for (const c of changed) if (c.id !== id) writeCard(dir, c);
  if (out !== moved || moved.order !== old.order) writeCard(dir, out);
  return out;
}

// The user's answer to a question card: record it, clear the flags and move the card to done.
export function answerCard(dir: string, id: number, input: Record<string, unknown>, ctx: Ctx): Card {
  const cards = loadCards(dir);
  const old = cards.find((c) => c.id === id);
  if (!old) throw new Error(`no card ${id}`);
  const picked = input.choices === undefined ? [] : cleanOptions(input.choices);
  const comment = input.comment === undefined ? "" : str(input.comment, "comment", 5000).trim();
  if (old.options.length) for (const o of picked) if (!old.options.includes(o)) throw new Error(`"${o.slice(0, 40)}" is not one of the options`);
  if (!old.multi && picked.length > 1) throw new Error("choose one option");
  if (!picked.length && !comment) throw new Error("choose an option or write an answer");
  const answer = [...picked.map((o) => `- ${o}`), ...(picked.length && comment ? [""] : []), ...(comment ? [comment] : [])].join("\n");
  const changed = placeCard(cards, id, "done", null);
  const next = { ...(changed.find((c) => c.id === id) ?? old), answer, needsYou: false, agent: "", agentAt: "" };
  const out = stamp(old, next, ctx);
  for (const c of changed) if (c.id !== id) writeCard(dir, c);
  writeCard(dir, out);
  return out;
}

export function convertSubtasks(dir: string, id: number, ctx: Ctx): Card {
  const old = loadCards(dir).find((c) => c.id === id);
  if (!old) throw new Error(`no card ${id}`);
  const next = { ...old, description: listToTasks(old.description) };
  const out = stamp(old, next, ctx, ["converted list to subtasks"]);
  if (out !== next) writeCard(dir, out);
  return out;
}

export function deleteCard(dir: string, id: number) {
  const c = loadCards(dir).find((x) => x.id === id);
  if (!c) throw new Error(`no card ${id}`);
  unlinkSync(join(dir, "cards", c.file));
}

export const AGENT_LIVE_MS = 5 * 60 * 1000;
const touchMinMs = 5000;
export const agentLabel = (s: string) => oneLine(s).slice(0, 8);

// A marker only means something while the card is in progress; elsewhere it is stale and ignored.
export const isAgentLive = (c: Pick<Card, "agent" | "agentAt" | "column">, now = new Date()) => {
  const t = Date.parse(c.agentAt);
  return c.column === "in-progress" && !!c.agent && Number.isFinite(t) && now.getTime() - t < AGENT_LIVE_MS;
};

const findCard = (dir: string, id: number) => {
  const c = loadCards(dir).find((x) => x.id === id);
  if (!c) throw new Error(`no card ${id}`);
  return c;
};

// raw keeps the full label (MCP servers); hook sessions are matched by their first 8 characters.
export function startAgent(dir: string, id: number, session: string, ctx: Ctx, raw = false): Card {
  const old = findCard(dir, id);
  if (old.column === "done") throw new Error(`card ${id} is done; move it back before starting an agent on it`);
  const agent = (raw ? oneLine(session).slice(0, 40) : agentLabel(session)) || "claude";
  const at = iso(ctx.now ?? new Date());
  const same = old.agent === agent;
  const out: Card = same
    ? { ...old, agentAt: at }
    : { ...old, agent, agentAt: at, created: old.created || at, updated: at, history: [...old.history, { at, text: "agent started", by: ctx.by }].slice(-maxHistory) };
  writeCard(dir, out);
  return out;
}

// Shared by `board start` and the MCP claim_card: todo/verify move to in-progress, in-progress is refreshed, the rest is refused.
export function claimCard(dir: string, id: number, session: string, ctx: Ctx, raw = false): Card {
  const c = findCard(dir, id);
  if (c.column === "inbox" || c.column === "planned") throw new Error(`card ${id} is not approved: it is in ${c.column}; the user moves it to todo`);
  if (c.column === "done") throw new Error(`card ${id} is done; the user moves it back before work can start`);
  if (c.column !== "in-progress") moveCard(dir, id, "in-progress", null, undefined, ctx);
  return startAgent(dir, id, session, ctx, raw);
}

export function stopAgent(dir: string, id: number, ctx: Ctx): Card {
  const old = findCard(dir, id);
  if (!old.agent) return old;
  const at = iso(ctx.now ?? new Date());
  const out: Card = { ...old, agent: "", agentAt: "", created: old.created || at, updated: at, history: [...old.history, { at, text: "agent stopped", by: ctx.by }].slice(-maxHistory) };
  writeCard(dir, out);
  return out;
}

// Heartbeat: refreshes agentAt only. Never touches updated or history, and skips writes within touchMinMs.
export function touchAgents(dir: string, session: string, now = new Date(), exact = false): number {
  const label = exact ? session : agentLabel(session);
  if (!label) return 0;
  let n = 0;
  for (const c of loadCards(dir)) {
    if (c.agent !== label || c.column !== "in-progress") continue;
    const last = Date.parse(c.agentAt);
    if (Number.isFinite(last) && now.getTime() - last < touchMinMs) continue;
    writeCard(dir, { ...c, agentAt: iso(now) });
    n++;
  }
  return n;
}

const start = "<!-- project-board:start -->";
const end = "<!-- project-board:end -->";

export const workflowBlock = (rel: string) => `${start}
## Board workflow
Work is tracked on a local kanban board (\`board\` command). Data lives in \`${rel}/\` and is gitignored.
- Columns: inbox, planned, todo, in-progress, verify, done. Blocked is a flag, not a column.
- Inbox -> Todo is the user's approval. Build only Todo items.
- At the start of each session run \`board list todo\` and \`board list in-progress\`.
- \`board start <id>\` moves a todo card to in-progress and marks you as working on it; use it (or \`claim_card\`) before doing any work. When done, move it to verify with \`board move <id> verify --notes "what ran + result" --steps "- [ ] check one\\n- [ ] check two"\` and run \`board stop <id>\`. Notes are for what you ran and the result; anything the user should check by hand goes in How to verify as \`- [ ]\` lines (\`--steps\`).
- Only the user moves cards to done.
- If the \`board\` MCP server is configured, use its tools instead (\`next_card\`, \`claim_card\`, \`add_note\`, \`move_to_verify\` with \`howToVerify\`, \`set_how_to_verify\`, \`add_card\`, \`release_card\`); agents cannot move cards to todo, planned or done.
- Add new items you find with \`board add "title"\`; they land in inbox. Use \`--needs-you\` for unsure items and decisions.
${end}
`;

export function isIgnored(gitignore: string, rel: string) {
  const parents = rel.split("/").map((_, i, a) => a.slice(0, i + 1).join("/"));
  return gitignore.split(/\r?\n/).some((l) => parents.includes(l.trim().replace(/^\/+|\/+$/g, "")));
}

type FileSync = "appended" | "updated" | "present" | "missing";
export type InitResult = { dir: string; gitignore: "added" | "already"; claude: FileSync; agents: FileSync };

export function initBoard(root: string): InitResult {
  const dir = boardDir(root);
  const rel = dir.slice(root.length + 1);
  mkdirSync(join(dir, "cards"), { recursive: true });
  mkdirSync(join(dir, "images"), { recursive: true });

  const giPath = join(root, ".gitignore");
  const gi = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  let gitignore: InitResult["gitignore"] = "already";
  if (!isIgnored(gi, rel)) {
    appendFileSync(giPath, `${gi && !gi.endsWith("\n") ? "\n" : ""}${rel}/\n`);
    gitignore = "added";
  }

  const sync = (name: string): InitResult["claude"] => {
    const p = join(root, name);
    if (!existsSync(p)) return "missing";
    const cm = readFileSync(p, "utf8");
    const s = cm.indexOf(start);
    const e = s >= 0 ? cm.indexOf(end, s) : -1;
    if (s < 0) {
      appendFileSync(p, `${cm.endsWith("\n") ? "" : "\n"}\n${workflowBlock(rel)}`);
      return "appended";
    }
    const next = e >= 0 ? `${cm.slice(0, s)}${workflowBlock(rel).trimEnd()}${cm.slice(e + end.length)}` : cm;
    if (next === cm) return "present";
    writeFileSync(p, next);
    return "updated";
  };
  const claude = sync("CLAUDE.md");
  const agents = sync("AGENTS.md");
  return { dir, gitignore, claude, agents };
}
