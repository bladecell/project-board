import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendNotes, convertSubtasks, parseHistoryLine, taskCounts, boardDir, createCard, initBoard, isIgnored, loadCards, moveCard, nextId, parseCard,
  placeCard, serializeCard, slugify, updateCard, type Card,
} from "./lib";

const cli = { by: "cli" as const };
const scratch = process.env.TMPDIR ?? tmpdir();
let root: string;
beforeEach(() => { root = mkdtempSync(join(scratch, "board-test-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const card = (o: Partial<Card>): Card => ({
  id: 1, file: "0001-a.md", column: "inbox", order: 1, type: "task", taskId: "", phase: "", lane: "",
  needsYou: false, blocked: false, title: "a", description: "", verifyNotes: "", howToVerify: "",
  created: "", updated: "", history: [], ...o,
});

describe("card parse/serialize", () => {
  test("parses frontmatter and sections", () => {
    const text = `---
column: verify
order: 3
type: bug
taskId: P2.3
phase: P2
lane: fw
needsYou: true
blocked: false
title: Fix: the thing
---

Some body
![](images/a.png)

## Verify notes
- ran it

## How to verify
- [ ] one
- [x] two
`;
    expect(parseCard("0012-fix.md", text)).toEqual({
      id: 12, file: "0012-fix.md", column: "verify", order: 3, type: "bug", taskId: "P2.3", phase: "P2", lane: "fw",
      needsYou: true, blocked: false, title: "Fix: the thing",
      description: "Some body\n![](images/a.png)", verifyNotes: "- ran it", howToVerify: "- [ ] one\n- [x] two",
      created: "", updated: "", history: [],
    });
  });

  test("round trips", () => {
    const c = card({ id: 5, file: "0005-a.md", taskId: "P1", needsYou: true, description: "d", verifyNotes: "n", howToVerify: "- [ ] x" });
    expect(parseCard(c.file, serializeCard(c))).toEqual(c);
  });

  test("defaults for missing or bad fields and CRLF", () => {
    const c = parseCard("0002-x.md", "---\r\ncolumn: nope\r\norder: abc\r\ntype: ??\r\n---\r\nbody\r\n")!;
    expect(c).toMatchObject({ column: "inbox", order: 0, type: "task", title: "x", description: "body" });
  });

  test("file without frontmatter keeps whole text as description", () => {
    expect(parseCard("0003-y.md", "just text")!.description).toBe("just text");
  });

  test("rejects names without numeric id", () => {
    expect(parseCard("notes.md", "x")).toBeNull();
  });

  test("newlines in single-line fields cannot inject frontmatter", () => {
    const out = serializeCard(card({ title: "a\ncolumn: done", lane: "x\nblocked: true" }));
    const back = parseCard("0001-a.md", out)!;
    expect(back.column).toBe("inbox");
    expect(back.blocked).toBe(false);
  });
});

describe("slug and ids", () => {
  test("slugify", () => {
    expect(slugify("Fix CAN  bus: Ünïcode!")).toBe("fix-can-bus-unicode");
    expect(slugify("../../etc/passwd")).toBe("etc-passwd");
    expect(slugify("???")).toBe("card");
    expect(slugify("a".repeat(100)).length).toBe(40);
  });
  test("nextId is max + 1, gaps included", () => {
    expect(nextId([])).toBe(1);
    expect(nextId([card({ id: 2 }), card({ id: 9 })])).toBe(10);
  });
});

describe("ordering and move", () => {
  const set = [
    card({ id: 1, column: "todo", order: 1 }), card({ id: 2, column: "todo", order: 2 }),
    card({ id: 3, column: "todo", order: 3 }), card({ id: 4, column: "inbox", order: 1 }),
  ];
  const orderOf = (cards: Card[], changed: Card[], col: string) =>
    cards.map((c) => changed.find((x) => x.id === c.id) ?? c).filter((c) => c.column === col)
      .sort((a, b) => a.order - b.order).map((c) => c.id);

  test("move to another column goes to end", () => {
    expect(orderOf(set, placeCard(set, 4, "todo"), "todo")).toEqual([1, 2, 3, 4]);
  });
  test("insert before a card in another column", () => {
    expect(orderOf(set, placeCard(set, 4, "todo", 2), "todo")).toEqual([1, 4, 2, 3]);
  });
  test("reorder inside a column", () => {
    expect(orderOf(set, placeCard(set, 3, "todo", 1), "todo")).toEqual([3, 1, 2]);
  });
  test("unknown beforeId appends; unchanged position returns nothing", () => {
    expect(orderOf(set, placeCard(set, 1, "todo", 999), "todo")).toEqual([2, 3, 1]);
    expect(placeCard(set, 3, "todo")).toEqual([]);
  });
  test("unknown card throws", () => {
    expect(() => placeCard(set, 99, "todo")).toThrow();
  });
  test("appendNotes", () => {
    const d = new Date("2026-01-02T00:00:00Z");
    const once = appendNotes(card({}), "ran tests", d);
    expect(once.verifyNotes).toBe("- 2026-01-02: ran tests");
    expect(appendNotes(once, "again", d).verifyNotes).toBe("- 2026-01-02: ran tests\n- 2026-01-02: again");
  });
});

describe("board files", () => {
  test("board dir is plan/board when plan/ exists, else board", () => {
    expect(boardDir(root)).toBe(join(root, "board"));
    mkdirSync(join(root, "plan"));
    expect(boardDir(root)).toBe(join(root, "plan/board"));
  });

  test("create assigns increasing ids, end order, slug file names", () => {
    initBoard(root);
    const dir = boardDir(root);
    const a = createCard(dir, { title: "First one" }, cli);
    const b = createCard(dir, { title: "Second", column: "todo" }, cli);
    const c = createCard(dir, { title: "Third", column: "todo", type: "bug", needsYou: true }, cli);
    expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
    expect([b.order, c.order]).toEqual([1, 2]);
    expect(readdirSync(join(dir, "cards")).sort()).toEqual(["0001-first-one.md", "0002-second.md", "0003-third.md"]);
    expect(loadCards(dir).find((x) => x.id === 3)).toMatchObject({ type: "bug", needsYou: true });
  });

  test("create rejects bad input", () => {
    initBoard(root);
    const dir = boardDir(root);
    expect(() => createCard(dir, {}, cli)).toThrow();
    expect(() => createCard(dir, { title: "x", column: "nope" }, cli)).toThrow();
    expect(() => createCard(dir, { title: "x", needsYou: "yes" }, cli)).toThrow();
  });

  test("move persists column and appends notes at end of target", () => {
    initBoard(root);
    const dir = boardDir(root);
    createCard(dir, { title: "a", column: "todo" }, cli);
    createCard(dir, { title: "b", column: "verify" }, cli);
    const moved = moveCard(dir, 1, "verify", null, "ran ci", cli);
    expect(moved.order).toBe(2);
    const reloaded = loadCards(dir).find((c) => c.id === 1)!;
    expect(reloaded.column).toBe("verify");
    expect(reloaded.verifyNotes).toContain("ran ci");
  });

  test("update patch keeps unrelated fields", () => {
    initBoard(root);
    const dir = boardDir(root);
    createCard(dir, { title: "a", phase: "P1" }, cli);
    updateCard(dir, 1, { blocked: true }, cli);
    expect(loadCards(dir)[0]).toMatchObject({ blocked: true, phase: "P1" });
  });

  test("no tmp files left behind", () => {
    initBoard(root);
    const dir = boardDir(root);
    createCard(dir, { title: "a" }, cli);
    expect(readdirSync(join(dir, "cards")).every((f) => f.endsWith(".md"))).toBe(true);
  });
});

describe("init", () => {
  test("is idempotent and appends gitignore + CLAUDE.md block once", () => {
    writeFileSync(join(root, "CLAUDE.md"), "# Proj");
    const first = initBoard(root);
    expect(first).toMatchObject({ gitignore: "added", claude: "appended" });
    const gi = readFileSync(join(root, ".gitignore"), "utf8");
    const cm = readFileSync(join(root, "CLAUDE.md"), "utf8");
    const second = initBoard(root);
    expect(second).toMatchObject({ gitignore: "already", claude: "present" });
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(gi);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(cm);
    expect(cm.match(/## Board workflow/g)?.length).toBe(1);
    expect(cm).toContain("`board/`");
    expect(gi).toBe("board/\n");
  });

  test("missing CLAUDE.md is reported, not created", () => {
    expect(initBoard(root).claude).toBe("missing");
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
  });

  test("plan/ already ignored needs no gitignore change", () => {
    mkdirSync(join(root, "plan"));
    writeFileSync(join(root, ".gitignore"), "node_modules\n/plan/\n");
    expect(initBoard(root).gitignore).toBe("already");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules\n/plan/\n");
  });

  test("isIgnored matches parent or exact path only", () => {
    expect(isIgnored("plan\n", "plan/board")).toBe(true);
    expect(isIgnored("plan/board/\n", "plan/board")).toBe(true);
    expect(isIgnored("board\n", "board")).toBe(true);
    expect(isIgnored("planner\n", "plan/board")).toBe(false);
    expect(isIgnored("", "board")).toBe(false);
  });

  test("appends newline before entry when gitignore lacks trailing newline", () => {
    writeFileSync(join(root, ".gitignore"), "dist");
    initBoard(root);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("dist\nboard/\n");
  });
});

describe("timestamps and history", () => {
  const t0 = new Date("2026-11-09T21:40:12Z");
  const t1 = new Date("2026-11-10T08:00:00Z");
  const setup = () => { initBoard(root); return boardDir(root); };
  const get = (dir: string, id = 1) => loadCards(dir).find((c) => c.id === id)!;
  const texts = (c: Card) => c.history.map((h) => h.text);

  test("create stamps created/updated and a created event with source", () => {
    const dir = setup();
    const c = createCard(dir, { title: "a" }, { by: "ui", now: t0 });
    expect(c).toMatchObject({ created: "2026-11-09T21:40:12Z", updated: "2026-11-09T21:40:12Z" });
    expect(c.history).toEqual([{ at: "2026-11-09T21:40:12Z", text: "created", by: "ui" }]);
    expect(get(dir)).toEqual(c);
  });

  test("history line format round trips and is last section", () => {
    const c = card({ created: "2026-11-09T21:40:12Z", updated: "2026-11-09T21:40:12Z", howToVerify: "- [ ] x",
      history: [{ at: "2026-11-09T21:40:12Z", text: "moved inbox → todo", by: "ui" }, { at: "2026-11-10T08:00:00Z", text: "a · b", by: "cli" }] });
    const out = serializeCard(c);
    expect(out).toContain("created: 2026-11-09T21:40:12Z\n");
    expect(out.trimEnd().endsWith("- 2026-11-10T08:00:00Z · a · b · cli")).toBe(true);
    expect(out).toContain("- 2026-11-09T21:40:12Z · moved inbox → todo · ui");
    expect(parseCard(c.file, out)).toEqual(c);
  });

  test("card without history parses to empty history; bad lines dropped", () => {
    expect(parseCard("0001-a.md", "---\ntitle: a\n---\n\nbody").history).toEqual([]);
    expect(parseCard("0001-a.md", "---\ntitle: a\n---\n\n## History\n- garbage\n- 2026-01-01T00:00:00Z · created · cli\n").history).toHaveLength(1);
    expect(parseHistoryLine("- nope")).toBeNull();
  });

  test("each event type is logged once, in order", () => {
    const dir = setup();
    createCard(dir, { title: "a", phase: "P1" }, { by: "ui", now: t0 });
    updateCard(dir, 1, { needsYou: true, blocked: true }, cli);
    updateCard(dir, 1, { needsYou: false, blocked: false }, cli);
    updateCard(dir, 1, { type: "bug", title: "b", phase: "P2", taskId: "T1", lane: "fw" }, cli);
    updateCard(dir, 1, { verifyNotes: "secret text" }, cli);
    moveCard(dir, 1, "todo", null, undefined, cli);
    const t = texts(get(dir));
    expect(t).toEqual([
      "created", "needs you set", "blocked set", "needs you cleared", "blocked cleared", "type task → bug", "title a → b",
      "phase P1 → P2", "taskId (none) → T1", "lane (none) → fw", "verify notes updated", "moved inbox → todo",
    ]);
    expect(t.join("\n")).not.toContain("secret");
  });

  test("description, howToVerify and tick edits only bump updated", () => {
    const dir = setup();
    createCard(dir, { title: "a", howToVerify: "- [ ] x" }, { by: "ui", now: t0 });
    const c = updateCard(dir, 1, { description: "new", howToVerify: "- [x] x" }, { by: "ui", now: t1 });
    expect(c.history).toHaveLength(1);
    expect(c.updated).toBe("2026-11-10T08:00:00Z");
    expect(c.created).toBe("2026-11-09T21:40:12Z");
  });

  test("no-op save changes nothing on disk", () => {
    const dir = setup();
    createCard(dir, { title: "a", phase: "P1" }, { by: "ui", now: t0 });
    const file = join(dir, "cards", "0001-a.md");
    const before = readFileSync(file, "utf8");
    updateCard(dir, 1, { title: "a", phase: "P1", needsYou: false, column: "inbox" }, { by: "ui", now: t1 });
    moveCard(dir, 1, "inbox", null, undefined, { by: "ui", now: t1 });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("move with notes logs moved and verify notes updated; neighbours untouched", () => {
    const dir = setup();
    createCard(dir, { title: "a", column: "todo" }, { by: "ui", now: t0 });
    createCard(dir, { title: "b", column: "todo" }, { by: "ui", now: t0 });
    moveCard(dir, 1, "verify", null, "ran", { by: "cli", now: t1 });
    expect(texts(get(dir, 1))).toEqual(["created", "moved todo → verify", "verify notes updated"]);
    expect(get(dir, 1).history.at(-1)).toMatchObject({ by: "cli", at: "2026-11-10T08:00:00Z" });
    expect(get(dir, 2)).toMatchObject({ order: 2, updated: "2026-11-09T21:40:12Z" });
    expect(get(dir, 2).history).toHaveLength(1);
  });

  test("history is capped at 200, oldest dropped", () => {
    const dir = setup();
    createCard(dir, { title: "a" }, { by: "ui", now: t0 });
    for (let i = 0; i < 210; i++) updateCard(dir, 1, { lane: `l${i}` }, cli);
    const c = get(dir);
    expect(c.history).toHaveLength(200);
    expect(c.history.at(-1)!.text).toBe("lane l208 → l209");
    expect(c.history[0].text).not.toBe("created");
  });

  test("injection: newlines, headings and long text cannot break the format", () => {
    const dir = setup();
    createCard(dir, { title: "a" }, cli);
    const evil = "x\n## Verify notes\n- 2026-01-01T00:00:00Z · fake · ui\n---\n" + "y".repeat(100);
    updateCard(dir, 1, { title: evil, description: "intro\n## History\n- 2026-01-01T00:00:00Z · fake · ui" }, cli);
    const c = get(dir);
    const last = c.history.at(-1)!;
    expect(last.text.length).toBeLessThanOrEqual(160);
    expect(last.text).not.toContain("\n");
    expect(c.history.every((h) => h.text !== "fake")).toBe(true);
    expect(c.history).toHaveLength(2);
    expect(c.verifyNotes).toBe("");
    expect(c.description).toContain("## History");
  });

  test("legacy cards backfill from file times on read and are not rewritten", () => {
    const dir = setup();
    const file = join(dir, "cards", "0001-old.md");
    writeFileSync(file, "---\ncolumn: todo\norder: 1\ntype: task\nneedsYou: false\nblocked: false\ntitle: old\n---\n\nbody\n");
    utimesSync(file, new Date("2026-05-01T10:00:00Z"), new Date("2026-05-02T11:00:00Z"));
    const before = readFileSync(file, "utf8");
    const c = get(dir);
    expect(c.updated).toBe("2026-05-02T11:00:00Z");
    expect(c.created).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(c.history).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(before);
    const saved = updateCard(dir, 1, { lane: "x" }, { by: "ui", now: t1 });
    expect(saved.created).toBe(c.created);
    expect(readFileSync(file, "utf8")).toContain(`created: ${c.created}`);
  });

  test("client-supplied timestamps and history are ignored", () => {
    const dir = setup();
    const c = createCard(dir, { title: "a", created: "2000-01-01T00:00:00Z", history: [{ at: "x", text: "y", by: "ui" }] }, { by: "ui", now: t0 });
    expect(c.created).toBe("2026-11-09T21:40:12Z");
    const u = updateCard(dir, 1, { lane: "z", updated: "1999-01-01T00:00:00Z", history: [] }, { by: "ui", now: t1 });
    expect(u.updated).toBe("2026-11-10T08:00:00Z");
    expect(u.history).toHaveLength(2);
  });
});

describe("tasks in cards", () => {
  const setup = () => { initBoard(root); return boardDir(root); };
  const get = (dir: string) => loadCards(dir)[0];

  test("taskCounts spans description and howToVerify, not verifyNotes", () => {
    expect(taskCounts(card({ description: "- [x] a\n- [ ] b", howToVerify: "- [ ] c", verifyNotes: "- [ ] ignored" }))).toEqual({ tasksDone: 1, tasksTotal: 3 });
    expect(taskCounts(card({}))).toEqual({ tasksDone: 0, tasksTotal: 0 });
  });

  test("ticking in any field only bumps updated, no history event", () => {
    const dir = setup();
    const t0 = new Date("2026-11-09T21:40:12Z");
    createCard(dir, { title: "a", description: "- [ ] d", verifyNotes: "- [ ] v", howToVerify: "- [ ] h" }, { by: "ui", now: t0 });
    const c = updateCard(dir, 1, { description: "- [x] d", verifyNotes: "- [x] v", howToVerify: "- [x] h" }, { by: "ui", now: new Date("2026-11-10T08:00:00Z") });
    expect(c.history.map((h) => h.text)).toEqual(["created"]);
    expect(c.updated).toBe("2026-11-10T08:00:00Z");
    const edited = updateCard(dir, 1, { verifyNotes: "- [x] v\n- [ ] new" }, { by: "ui", now: t0 });
    expect(edited.history.at(-1)!.text).toBe("verify notes updated");
  });

  test("convertSubtasks rewrites the description once, logs a cli event, then is a no-op", () => {
    const dir = setup();
    createCard(dir, { title: "a", description: "intro\n- 1. Header\n- 2. Tabs\n```\n- code\n```" }, { by: "ui", now: new Date("2026-11-09T21:40:12Z") });
    const first = convertSubtasks(dir, 1, { by: "cli", now: new Date("2026-11-10T08:00:00Z") });
    expect(first.description).toBe("intro\n- [ ] 1. Header\n- [ ] 2. Tabs\n```\n- code\n```");
    expect(first.history.at(-1)).toEqual({ at: "2026-11-10T08:00:00Z", text: "converted list to subtasks", by: "cli" });
    const file = join(dir, "cards", "0001-a.md");
    const before = readFileSync(file, "utf8");
    const second = convertSubtasks(dir, 1, { by: "cli", now: new Date("2026-11-11T08:00:00Z") });
    expect(second.history).toHaveLength(2);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(get(dir).description).toBe(first.description);
    expect(() => convertSubtasks(dir, 9, { by: "cli" })).toThrow();
  });
});
