import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  refreshWorkflow, answerCard, reopenCard, optLabel, optReason, cleanOptions, agentLabel, appendNotes, convertSubtasks, isAgentLive, AGENT_LIVE_MS, claimCard, startAgent, stopAgent, touchAgents, workflowBlock, parseHistoryLine, taskCounts, boardDir, createCard, initBoard, isIgnored, loadCards, moveCard, nextId, parseCard,
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
  options: [], recommended: "", multi: false, answer: "", created: "", updated: "", history: [], agent: "", agentAt: "", ...o,
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
      options: [], recommended: "", multi: false, answer: "",
      id: 12, file: "0012-fix.md", column: "verify", order: 3, type: "bug", taskId: "P2.3", phase: "P2", lane: "fw",
      needsYou: true, blocked: false, title: "Fix: the thing",
      description: "Some body\n![](images/a.png)", verifyNotes: "- ran it", howToVerify: "- [ ] one\n- [x] two",
      created: "", updated: "", history: [], agent: "", agentAt: "",
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

describe("agent marker", () => {
  const t0 = new Date("2026-11-09T21:40:12Z");
  const at = (s: number) => new Date(t0.getTime() + s * 1000);
  const setup = () => {
    initBoard(root);
    const dir = boardDir(root);
    createCard(dir, { title: "a", column: "in-progress" }, { by: "ui", now: t0 });
    createCard(dir, { title: "b", column: "in-progress" }, { by: "ui", now: t0 });
    return dir;
  };
  const get = (dir: string, id = 1) => loadCards(dir).find((c) => c.id === id)!;

  test("agent fields round trip and cards without them still parse", () => {
    const c = card({ agent: "abc12345", agentAt: "2026-11-09T21:40:12Z" });
    const out = serializeCard(c);
    expect(out).toContain("agent: abc12345\nagentAt: 2026-11-09T21:40:12Z\n");
    expect(parseCard(c.file, out)).toEqual(c);
    expect(serializeCard(card({}))).not.toContain("agent");
    expect(parseCard("0001-a.md", "---\ntitle: a\n---\n").agent).toBe("");
  });

  test("agentLabel keeps the first 8 characters, single line", () => {
    expect(agentLabel("0123456789abcdef")).toBe("01234567");
    expect(agentLabel("a\nb")).toBe("a b");
    expect(agentLabel("")).toBe("");
  });

  test("start sets the marker with one history line and bumps updated; no column move", () => {
    const dir = setup();
    const c = startAgent(dir, 1, "0123456789", { by: "cli", now: at(60) });
    expect(c).toMatchObject({ agent: "01234567", agentAt: "2026-11-09T21:41:12Z", column: "in-progress", updated: "2026-11-09T21:41:12Z" });
    expect(c.history.map((h) => [h.text, h.by])).toEqual([["created", "ui"], ["agent started", "cli"]]);
    expect(get(dir)).toEqual(c);
  });

  test("restarting with the same label refreshes the heartbeat without a new event", () => {
    const dir = setup();
    startAgent(dir, 1, "abc", { by: "cli", now: at(0) });
    const c = startAgent(dir, 1, "abc", { by: "cli", now: at(120) });
    expect(c.history).toHaveLength(2);
    expect(c.agentAt).toBe("2026-11-09T21:42:12Z");
    expect(startAgent(dir, 1, "other", { by: "cli", now: at(130) }).history.at(-1)!.text).toBe("agent started");
  });

  test("stop clears the marker with one history line; stopping an idle card is a no-op", () => {
    const dir = setup();
    expect(stopAgent(dir, 1, { by: "cli", now: at(5) }).history).toHaveLength(1);
    startAgent(dir, 1, "abc", { by: "cli", now: at(10) });
    const c = stopAgent(dir, 1, { by: "cli", now: at(20) });
    expect(c).toMatchObject({ agent: "", agentAt: "" });
    expect(c.history.map((h) => h.text)).toEqual(["created", "agent started", "agent stopped"]);
    expect(serializeCard(get(dir))).not.toContain("agent:");
    expect(() => stopAgent(dir, 9, { by: "cli" })).toThrow();
  });

  test("touch refreshes only matching cards by 8-char prefix, no updated bump, no history", () => {
    const dir = setup();
    startAgent(dir, 1, "0123456789abcdef", { by: "cli", now: at(0) });
    startAgent(dir, 2, "zzzzzzzz", { by: "cli", now: at(0) });
    const before = get(dir);
    expect(touchAgents(dir, "0123456789-a-different-tail", at(60))).toBe(1);
    const after = get(dir);
    expect(after.agentAt).toBe("2026-11-09T21:41:12Z");
    expect(after.updated).toBe(before.updated);
    expect(after.history).toEqual(before.history);
    expect(get(dir, 2).agentAt).toBe("2026-11-09T21:40:12Z");
    expect(touchAgents(dir, "nomatch0", at(70))).toBe(0);
    expect(touchAgents(dir, "", at(70))).toBe(0);
  });

  test("frequent heartbeats are not rewritten", () => {
    const dir = setup();
    startAgent(dir, 1, "abc", { by: "cli", now: at(0) });
    const file = join(dir, "cards", "0001-a.md");
    const before = readFileSync(file, "utf8");
    expect(touchAgents(dir, "abc", at(2))).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(touchAgents(dir, "abc", at(6))).toBe(1);
  });

  test("every move out of in-progress clears the marker with one history line", () => {
    for (const [col, by] of [["verify", "cli"], ["done", "ui"], ["todo", "ui"], ["planned", "cli"], ["inbox", "ui"]] as const) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      const dir = setup();
      startAgent(dir, 1, "abc", { by: "cli", now: at(0) });
      const out = moveCard(dir, 1, col, null, undefined, { by, now: at(10) });
      expect(out).toMatchObject({ column: col, agent: "", agentAt: "" });
      expect(out.history.map((h) => h.text).filter((x) => x === "agent stopped")).toHaveLength(1);
      expect(serializeCard(get(dir))).not.toContain("agent:");
    }
  });
  test("a PUT-style column change clears it too; an explicit stop afterwards adds no second line", () => {
    const dir = setup();
    startAgent(dir, 1, "abc", { by: "cli", now: at(0) });
    const out = updateCard(dir, 1, { column: "verify" }, { by: "ui", now: at(5) });
    expect(out.agent).toBe("");
    expect(stopAgent(dir, 1, cli).history.filter((h) => h.text === "agent stopped")).toHaveLength(1);
  });
  test("moving a card without a marker adds no agent line; moves within in-progress keep it", () => {
    const dir = setup();
    expect(moveCard(dir, 2, "verify", null, undefined, cli).history.map((h) => h.text)).not.toContain("agent stopped");
    startAgent(dir, 1, "abc", { by: "cli", now: at(0) });
    expect(moveCard(dir, 1, "in-progress", 2, undefined, cli).agent).toBe("abc");
  });
  test("touch ignores cards outside in-progress and does not resurrect them", () => {
    const dir = setup();
    startAgent(dir, 1, "abc", { by: "cli", now: at(0) });
    const file = join(dir, "cards", "0001-a.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("column: in-progress", "column: verify"));
    const before = readFileSync(file, "utf8");
    expect(touchAgents(dir, "abc", at(100))).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
  test("start from each column: todo/verify move to in-progress, in-progress refreshes, inbox/planned/done refuse", () => {
    for (const [col, ok] of [["todo", true], ["in-progress", true], ["verify", true], ["inbox", false], ["planned", false], ["done", false]] as const) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      initBoard(root);
      const dir = boardDir(root);
      const c0 = createCard(dir, { title: "a", column: col }, { by: "ui", now: t0 });
      if (!ok) {
        expect(() => claimCard(dir, 1, "abc", cli)).toThrow(col === "done" ? /done/ : /not approved: it is in .*the user moves it to todo/);
        expect(get(dir)).toEqual(c0);
        continue;
      }
      const out = claimCard(dir, 1, "abc", { by: "cli", now: at(30) });
      expect(out).toMatchObject({ column: "in-progress", agent: "abc" });
      const texts = out.history.map((h) => h.text);
      expect(texts.filter((x) => x === "agent started")).toHaveLength(1);
      expect(texts.filter((x) => x.startsWith("moved"))).toHaveLength(col === "in-progress" ? 0 : 1);
      if (col !== "in-progress") expect(out.history.find((h) => h.text.startsWith("moved"))).toMatchObject({ text: `moved ${col} → in-progress`, by: "cli" });
    }
  });
  test("start refuses done cards", () => {
    const dir = setup();
    moveCard(dir, 1, "done", null, undefined, cli);
    expect(() => startAgent(dir, 1, "abc", cli)).toThrow(/done/);
  });
  test("liveness window boundary", () => {
    const c = card({ agent: "abc", agentAt: "2026-11-09T21:40:12Z", column: "in-progress" });
    const base = Date.parse(c.agentAt);
    expect(isAgentLive(c, new Date(base + AGENT_LIVE_MS - 1))).toBe(true);
    expect(isAgentLive(c, new Date(base + AGENT_LIVE_MS))).toBe(false);
    expect(isAgentLive(card({}), new Date(base))).toBe(false);
    expect(isAgentLive(card({ agent: "abc", column: "in-progress" }), new Date(base))).toBe(false);
    for (const column of ["inbox", "planned", "todo", "verify", "done"] as const) expect(isAgentLive({ ...c, column }, new Date(base))).toBe(false);
    expect(AGENT_LIVE_MS).toBe(5 * 60 * 1000);
  });

  test("API-style patches cannot set the agent marker", () => {
    const dir = setup();
    const c = updateCard(dir, 1, { agent: "evil", agentAt: "2026-11-09T21:40:12Z", lane: "x" }, cli);
    expect(c.agent).toBe("");
  });
});

describe("init refreshes the workflow block", () => {
  test("an outdated marked block is replaced in place, text around it kept", () => {
    writeFileSync(join(root, "CLAUDE.md"), "# Proj\n\n<!-- project-board:start -->\n## Board workflow\nold text\n<!-- project-board:end -->\n\nafter me\n");
    expect(initBoard(root).claude).toBe("updated");
    const cm = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(cm).toContain(workflowBlock("board").trimEnd());
    expect(cm).not.toContain("old text");
    expect(cm.startsWith("# Proj\n\n")).toBe(true);
    expect(cm.endsWith("\n\nafter me\n")).toBe(true);
    expect(cm.match(/project-board:start/g)).toHaveLength(1);
    expect(initBoard(root).claude).toBe("present");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(cm);
  });
  test("block mentions start and stop", () => {
    expect(workflowBlock("board")).toContain("board start <id>");
    expect(workflowBlock("board")).toContain("moves a todo card to in-progress");
    expect(workflowBlock("board")).toContain("board stop <id>");
  });
  test("a start marker without an end marker is left alone", () => {
    writeFileSync(join(root, "CLAUDE.md"), "x\n<!-- project-board:start -->\nhand edited\n");
    expect(initBoard(root).claude).toBe("present");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("x\n<!-- project-board:start -->\nhand edited\n");
  });
});

describe("question cards", () => {
  const ask = (extra: Record<string, unknown> = {}) => { initBoard(root); const d = boardDir(root); return { d, c: createCard(d, { title: "Pick a broker", type: "decision", needsYou: true, options: ["Mosquitto", "EMQX"], ...extra }, cli) }; };
  test("options, multi and answer survive a round trip", () => {
    const c = card({ options: ["A", "B"], multi: true, answer: "- A\n\nbecause" });
    expect(parseCard(c.file, serializeCard(c))).toMatchObject({ options: ["A", "B"], multi: true, answer: "- A\n\nbecause" });
  });
  test("a description heading named Options or Answer cannot forge the sections", () => {
    const c = card({ description: "## Options\n- fake\n## Answer\nfake" });
    const back = parseCard(c.file, serializeCard(c))!;
    expect(back.options).toEqual([]);
    expect(back.answer).toBe("");
  });
  test("cleanOptions trims, dedupes, caps and rejects non-strings", () => {
    expect(cleanOptions([" a ", "a", "", "b\nc"])).toEqual(["a", "b c"]);
    expect(() => cleanOptions("x")).toThrow();
    expect(() => cleanOptions([1])).toThrow();
    expect(() => cleanOptions(Array.from({ length: 13 }, (_, i) => `o${i}`))).toThrow();
    expect(() => cleanOptions(["x".repeat(301)])).toThrow();
  });
  test("answering records the choice, clears needs-you and moves to done", () => {
    const { d, c } = ask();
    const out = answerCard(d, c.id, { choices: ["EMQX"], comment: "needs clustering" }, { by: "ui" });
    expect(out).toMatchObject({ column: "done", needsYou: false, answer: "- EMQX\n\nneeds clustering" });
    expect(out.history.map((h) => h.text).join("|")).toContain("answered");
  });
  test("single choice rejects several, unknown options and empty answers", () => {
    const { d, c } = ask();
    expect(() => answerCard(d, c.id, { choices: ["Mosquitto", "EMQX"] }, cli)).toThrow("choose one");
    expect(() => answerCard(d, c.id, { choices: ["Nope"] }, cli)).toThrow("not one of");
    expect(() => answerCard(d, c.id, { choices: [] }, cli)).toThrow("choose an option");
    expect(() => answerCard(d, 99, { comment: "x" }, cli)).toThrow("no card");
  });
  test("multi accepts several; a free-text answer works without options", () => {
    const m = ask({ multi: true });
    expect(answerCard(m.d, m.c.id, { choices: ["Mosquitto", "EMQX"] }, cli).answer).toBe("- Mosquitto\n- EMQX");
    const f = createCard(m.d, { title: "Free", type: "decision" }, cli);
    expect(answerCard(m.d, f.id, { comment: "use TLS" }, cli).answer).toBe("use TLS");
  });
  test("reasons ride in the option text; labels are what gets answered and deduped", () => {
    expect(optLabel("Keep :: cheap and tested")).toBe("Keep");
    expect(optReason("Keep :: cheap :: and tested")).toBe("cheap :: and tested");
    expect(optReason("Keep")).toBe("");
    expect(cleanOptions(["A :: x", "A :: y", "B"])).toEqual(["A :: x", "B"]);
    const { d, c } = ask({ options: ["Keep :: cheap", "Rewrite :: costly"], recommended: "Keep" });
    expect(c.recommended).toBe("Keep");
    expect(answerCard(d, c.id, { choices: ["Keep"] }, cli).answer).toBe("- Keep");
  });
  test("recommended must be an option, and is dropped when its option is removed", () => {
    const { d, c } = ask({ recommended: "EMQX" });
    expect(() => createCard(d, { title: "x", options: ["A", "B"], recommended: "Z" }, cli)).toThrow("recommended must be");
    expect(parseCard(c.file, serializeCard(c))!.recommended).toBe("EMQX");
    expect(updateCard(d, c.id, { options: ["Mosquitto"] }, cli).recommended).toBe("");
  });
  test("reopen clears the answer, flags needs-you, returns to inbox and keeps the old answer in history", () => {
    const { d, c } = ask();
    answerCard(d, c.id, { choices: ["EMQX"] }, cli);
    const out = reopenCard(d, c.id, cli);
    expect(out).toMatchObject({ column: "inbox", needsYou: true, answer: "" });
    expect(out.history.some((h) => h.text.includes("previous answer: - EMQX"))).toBe(true);
    expect(() => reopenCard(d, c.id, cli)).toThrow("no answer");
  });
});

describe("workflow block in the project", () => {
  test("init creates CLAUDE.md when no agent doc exists", () => {
    const r = initBoard(root);
    expect(r.claude).toBe("created");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("## Board workflow");
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
  });
  test("init leaves an existing AGENTS.md as the only doc and appends to it", () => {
    writeFileSync(join(root, "AGENTS.md"), "# mine\n");
    const r = initBoard(root);
    expect(r.claude).toBe("created");
    expect(r.agents).toBe("appended");
  });
  test("refresh updates a stale block, never adds one, and is a no-op when current", () => {
    expect(refreshWorkflow(root)).toEqual([]);
    initBoard(root);
    expect(refreshWorkflow(root)).toEqual([]);
    const p = join(root, "CLAUDE.md");
    writeFileSync(p, readFileSync(p, "utf8").replace("## Board workflow", "## Board workflow\nstale line"));
    expect(refreshWorkflow(root)).toEqual(["CLAUDE.md"]);
    expect(readFileSync(p, "utf8")).not.toContain("stale line");
    writeFileSync(join(root, "AGENTS.md"), "# no block here\n");
    expect(refreshWorkflow(root)).toEqual([]);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).not.toContain("Board workflow");
  });
});
