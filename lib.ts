import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const columns = ["inbox", "planned", "todo", "in-progress", "verify", "done"] as const;
export const types = ["bug", "feature", "task", "decision"] as const;
export type Column = (typeof columns)[number];
export type CardType = (typeof types)[number];

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
};

export type Patch = Partial<Omit<Card, "id" | "file" | "order">>;

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

const sections = { "verify notes": "verifyNotes", "how to verify": "howToVerify" } as const;

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
  const parts = { description: [] as string[], verifyNotes: [] as string[], howToVerify: [] as string[] };
  let cur: keyof typeof parts = "description";
  for (const l of lines.slice(bodyStart)) {
    const m = /^##\s+(verify notes|how to verify)\s*$/i.exec(l);
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
  };
}

export function serializeCard(c: Card): string {
  const head = [`column: ${c.column}`, `order: ${c.order}`, `type: ${c.type}`];
  if (c.taskId) head.push(`taskId: ${oneLine(c.taskId)}`);
  if (c.phase) head.push(`phase: ${oneLine(c.phase)}`);
  if (c.lane) head.push(`lane: ${oneLine(c.lane)}`);
  head.push(`needsYou: ${c.needsYou}`, `blocked: ${c.blocked}`, `title: ${oneLine(c.title)}`);
  const body = [c.description.trim()];
  if (c.verifyNotes.trim()) body.push(`## Verify notes\n${c.verifyNotes.trim()}`);
  if (c.howToVerify.trim()) body.push(`## How to verify\n${c.howToVerify.trim()}`);
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

export function appendNotes(c: Card, notes: string, date = new Date()): Card {
  const line = `- ${date.toISOString().slice(0, 10)}: ${oneLine(notes)}`;
  return { ...c, verifyNotes: c.verifyNotes ? `${c.verifyNotes}\n${line}` : line };
}

const str = (v: unknown, name: string, max: number) => {
  if (typeof v !== "string") throw new Error(`${name} must be a string`);
  if (v.length > max) throw new Error(`${name} too long`);
  return v;
};

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
  return out;
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
      const c = parseCard(f, readFileSync(join(cardsDir, f), "utf8"));
      return c ? [c] : [];
    } catch {
      return [];
    }
  });
}

export const writeCard = (dir: string, c: Card) => atomicWrite(join(dir, "cards", c.file), serializeCard(c));

export function createCard(dir: string, input: Record<string, unknown>): Card {
  const cards = loadCards(dir);
  const id = nextId(cards);
  const base = applyPatch({
    id, file: "", column: "inbox", order: 0, type: "task", taskId: "", phase: "", lane: "",
    needsYou: false, blocked: false, title: "", description: "", verifyNotes: "", howToVerify: "",
  }, input);
  if (!base.title) throw new Error("title required");
  const card = { ...base, file: fileName(id, base.title), order: endOrder(cards, base.column) };
  writeCard(dir, card);
  return card;
}

export function updateCard(dir: string, id: number, patch: Record<string, unknown>): Card {
  const cards = loadCards(dir);
  const old = cards.find((c) => c.id === id);
  if (!old) throw new Error(`no card ${id}`);
  const next = applyPatch(old, patch);
  writeCard(dir, next);
  return next;
}

export function moveCard(dir: string, id: number, column: Column, beforeId: number | null = null, notes?: string): Card {
  const cards = loadCards(dir);
  const old = cards.find((c) => c.id === id);
  if (!old) throw new Error(`no card ${id}`);
  const changed = placeCard(cards, id, column, beforeId);
  let moved = changed.find((c) => c.id === id) ?? old;
  if (notes) moved = appendNotes(moved, notes);
  for (const c of changed) writeCard(dir, c.id === id ? moved : c);
  if (!changed.some((c) => c.id === id)) writeCard(dir, moved);
  return moved;
}

export function deleteCard(dir: string, id: number) {
  const c = loadCards(dir).find((x) => x.id === id);
  if (!c) throw new Error(`no card ${id}`);
  unlinkSync(join(dir, "cards", c.file));
}

const start = "<!-- project-board:start -->";

export const workflowBlock = (rel: string) => `${start}
## Board workflow
Work is tracked on a local kanban board (\`board\` command). Data lives in \`${rel}/\` and is gitignored.
- Columns: inbox, planned, todo, in-progress, verify, done. Blocked is a flag, not a column.
- Inbox -> Todo is the user's approval. Build only Todo items.
- At the start of each session run \`board list todo\` and \`board list in-progress\`.
- Move a card to in-progress when you start it. When done, move it to verify: \`board move <id> verify --notes "what ran + result"\`.
- Only the user moves cards to done.
- Add new items you find with \`board add "title"\`; they land in inbox. Use \`--needs-you\` for unsure items and decisions.
<!-- project-board:end -->
`;

export function isIgnored(gitignore: string, rel: string) {
  const parents = rel.split("/").map((_, i, a) => a.slice(0, i + 1).join("/"));
  return gitignore.split(/\r?\n/).some((l) => parents.includes(l.trim().replace(/^\/+|\/+$/g, "")));
}

export type InitResult = { dir: string; gitignore: "added" | "already"; claude: "appended" | "present" | "missing" };

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

  const cmPath = join(root, "CLAUDE.md");
  let claude: InitResult["claude"] = "missing";
  if (existsSync(cmPath)) {
    const cm = readFileSync(cmPath, "utf8");
    if (cm.includes(start)) claude = "present";
    else {
      appendFileSync(cmPath, `${cm.endsWith("\n") ? "" : "\n"}\n${workflowBlock(rel)}`);
      claude = "appended";
    }
  }
  return { dir, gitignore, claude };
}
