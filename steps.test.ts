import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitInlineTasks, renderMarkdown, countTasks } from "./public/markdown.js";
import { addSteps, appendNotes, boardDir, createCard, initBoard, loadCards, moveCard, parseCard, serializeCard, setSteps, normalizeSteps } from "./lib";

const scratch = "/tmp/claude-1000/-home-kuba-dev-esp-CAN-Sniffer/0b32f9e8-d0b6-45bf-89f0-a627f3af6ebb/scratchpad";
const flat = "Not viewed in a browser. - [ ] Phone: layout fits - [ ] Desktop: columns align - [x] New dashboard loads";
const cli = { by: "cli" as const };
const mk = () => {
  const root = mkdtempSync(join(scratch, "steps-"));
  initBoard(root);
  return { root, dir: boardDir(root) };
};

describe("splitInlineTasks", () => {
  test("the flattened example becomes one item per line", () => {
    const out = splitInlineTasks(flat);
    expect(out).toBe("Not viewed in a browser.\n- [ ] Phone: layout fits\n- [ ] Desktop: columns align\n- [x] New dashboard loads");
    expect(countTasks(out)).toEqual({ done: 1, total: 3 });
    expect(renderMarkdown(out)).toContain('type="checkbox"');
  });
  test("already-correct text, code fences and plain dashes are untouched", () => {
    const ok = "- [ ] a\n- [ ] b\n\ntext - not a task\n```\nx - [ ] y\n```\n";
    expect(splitInlineTasks(ok)).toBe(ok);
    expect(splitInlineTasks("a - b - [c]")).toBe("a - b - [c]");
    expect(splitInlineTasks("")).toBe("");
  });
});

describe("steps", () => {
  test("normalizeSteps splits and trims", () => {
    expect(normalizeSteps("- [ ] a - [ ] b")).toBe("- [ ] a\n- [ ] b");
  });
  test("addSteps appends only new lines, keeps existing text, dedupes ignoring tick state", () => {
    const base = parseCard("0001-a.md", "---\ntitle: a\n---\n\n## How to verify\nuser text\n- [x] flash it\n")!;
    const out = addSteps(base, "- [ ] flash it - [ ] watch the log\n- [ ] watch the log");
    expect(out.howToVerify).toBe("user text\n- [x] flash it\n- [ ] watch the log");
    expect(addSteps(out, "- [ ] watch the log").howToVerify).toBe(out.howToVerify);
  });
  test("accepts literal backslash-n and CRLF as newlines", () => {
    const c = parseCard("0001-a.md", "---\ntitle: a\n---\n")!;
    expect(addSteps(c, "- [ ] a\\n- [ ] b").howToVerify).toBe("- [ ] a\n- [ ] b");
    expect(addSteps(c, "- [ ] a\r\n- [ ] b").howToVerify).toBe("- [ ] a\n- [ ] b");
  });
  test("setSteps writes, adds history once, is a no-op when nothing is new", () => {
    const { root, dir } = mk();
    try {
      const c = createCard(dir, { title: "t" }, cli);
      const a = setSteps(dir, c.id, "- [ ] one - [ ] two", { by: "mcp:x" });
      expect(a.howToVerify).toBe("- [ ] one\n- [ ] two");
      expect(a.history.at(-1)).toMatchObject({ text: "verify steps added", by: "mcp:x" });
      const b = setSteps(dir, c.id, "- [ ] one", cli);
      expect(b.history).toHaveLength(a.history.length);
      expect(loadCards(dir)[0].howToVerify).toBe("- [ ] one\n- [ ] two");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("moveCard with steps appends them and logs", () => {
    const { root, dir } = mk();
    try {
      const c = createCard(dir, { title: "t", column: "in-progress" }, cli);
      const m = moveCard(dir, c.id, "verify", null, "ran tests", cli, "- [ ] check phone");
      expect(m.howToVerify).toBe("- [ ] check phone");
      expect(m.history.map((h) => h.text)).toContain("verify steps added");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("multi-line notes", () => {
  test("newlines survive write and read; sections still parse", () => {
    const c = parseCard("0001-a.md", "---\ntitle: a\n---\n\nbody\n")!;
    const n = appendNotes(c, "ran it\n## History\n- [ ] sneaky\n## How to verify\nnot steps", new Date("2026-11-09T00:00:00Z"));
    const back = parseCard("0001-a.md", serializeCard({ ...n, history: [{ at: "2026-11-09T00:00:00Z", text: "created", by: "cli" }] }))!;
    expect(back.verifyNotes).toBe(n.verifyNotes);
    expect(back.verifyNotes.split("\n")).toHaveLength(5);
    expect(back.howToVerify).toBe("");
    expect(back.history).toHaveLength(1);
    expect(back.description).toBe("body");
  });
  test("flattened tick boxes in notes become separate lines", () => {
    const c = parseCard("0001-a.md", "---\ntitle: a\n---\n")!;
    const n = appendNotes(c, flat);
    expect(n.verifyNotes.split("\n")).toHaveLength(4);
    expect(countTasks(n.verifyNotes).total).toBe(3);
  });
  test("a second note adds a new dated item after multi-line one", () => {
    const c = parseCard("0001-a.md", "---\ntitle: a\n---\n")!;
    const n = appendNotes(appendNotes(c, "a\nb"), "c");
    expect(n.verifyNotes).toMatch(/^- \d{4}-\d\d-\d\d: a\n  b\n- \d{4}-\d\d-\d\d: c$/);
  });
});
