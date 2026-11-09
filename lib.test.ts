import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendNotes, boardDir, createCard, initBoard, isIgnored, loadCards, moveCard, nextId, parseCard,
  placeCard, serializeCard, slugify, updateCard, type Card,
} from "./lib";

const scratch = process.env.TMPDIR ?? tmpdir();
let root: string;
beforeEach(() => { root = mkdtempSync(join(scratch, "board-test-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const card = (o: Partial<Card>): Card => ({
  id: 1, file: "0001-a.md", column: "inbox", order: 1, type: "task", taskId: "", phase: "", lane: "",
  needsYou: false, blocked: false, title: "a", description: "", verifyNotes: "", howToVerify: "", ...o,
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
    const a = createCard(dir, { title: "First one" });
    const b = createCard(dir, { title: "Second", column: "todo" });
    const c = createCard(dir, { title: "Third", column: "todo", type: "bug", needsYou: true });
    expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
    expect([b.order, c.order]).toEqual([1, 2]);
    expect(readdirSync(join(dir, "cards")).sort()).toEqual(["0001-first-one.md", "0002-second.md", "0003-third.md"]);
    expect(loadCards(dir).find((x) => x.id === 3)).toMatchObject({ type: "bug", needsYou: true });
  });

  test("create rejects bad input", () => {
    initBoard(root);
    const dir = boardDir(root);
    expect(() => createCard(dir, {})).toThrow();
    expect(() => createCard(dir, { title: "x", column: "nope" })).toThrow();
    expect(() => createCard(dir, { title: "x", needsYou: "yes" })).toThrow();
  });

  test("move persists column and appends notes at end of target", () => {
    initBoard(root);
    const dir = boardDir(root);
    createCard(dir, { title: "a", column: "todo" });
    createCard(dir, { title: "b", column: "verify" });
    const moved = moveCard(dir, 1, "verify", null, "ran ci");
    expect(moved.order).toBe(2);
    const reloaded = loadCards(dir).find((c) => c.id === 1)!;
    expect(reloaded.column).toBe("verify");
    expect(reloaded.verifyNotes).toContain("ran ci");
  });

  test("update patch keeps unrelated fields", () => {
    initBoard(root);
    const dir = boardDir(root);
    createCard(dir, { title: "a", phase: "P1" });
    updateCard(dir, 1, { blocked: true });
    expect(loadCards(dir)[0]).toMatchObject({ blocked: true, phase: "P1" });
  });

  test("no tmp files left behind", () => {
    initBoard(root);
    const dir = boardDir(root);
    createCard(dir, { title: "a" });
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
