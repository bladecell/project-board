import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCommits, linkCommits, type Commit } from "./commits";

const c = (subject: string, i = 0): Commit => ({ hash: `h${i}`.padEnd(40, "0"), short: `h${i}`, at: "2026-01-01T00:00:00+00:00", author: "a", subject });
const ids = (subjects: string[], card: { id: number; taskId: string }) =>
  (linkCommits(subjects.map(c), [card]).get(card.id) ?? []).map((x) => x.subject);

describe("linkCommits matching", () => {
  test("task id must be a whole token", () => {
    const hits = ids(["P2.3: fix", "P2.30: no", "P2.3b: no", "xP2.3: no", "fix P2.3 end.", "P2.3.1: no", "see (P2.3)", "P2x3: no"], { id: 1, taskId: "P2.3" });
    expect(hits).toEqual(["P2.3: fix", "fix P2.3 end.", "see (P2.3)"]);
  });
  test("UI19 does not match UI19a or UI190, is case sensitive", () => {
    expect(ids(["UI19: a", "UI19a: b", "UI190: c", "ui19: d", "x UI19"], { id: 1, taskId: "UI19" })).toEqual(["UI19: a", "x UI19"]);
  });
  test("#id is a whole token", () => {
    expect(ids(["fix #42", "fix #420", "(#42)", "a#42", "#42: x", "#4"], { id: 42, taskId: "" })).toEqual(["fix #42", "(#42)", "#42: x"]);
  });
  test("empty taskId never matches everything", () => {
    expect(ids(["anything", "#7 yes"], { id: 7, taskId: "" })).toEqual(["#7 yes"]);
  });
  test("one commit can link to several cards", () => {
    const m = linkCommits([c("P1.1 and P1.2, closes #9")], [{ id: 1, taskId: "P1.1" }, { id: 2, taskId: "P1.2" }, { id: 9, taskId: "" }, { id: 3, taskId: "P1.3" }]);
    expect([...m.keys()].sort()).toEqual([1, 2, 9]);
  });
  test("regex metacharacters in ids are literal and never throw", () => {
    for (const taskId of ["A+B(1)", "[x", "a|b", "(", "\\", ".*", "P2.3"]) {
      expect(() => linkCommits([c("A+B(1): x"), c("axb")], [{ id: 1, taskId }])).not.toThrow();
    }
    expect(ids(["A+B(1): x", "AAB1: y"], { id: 1, taskId: "A+B(1)" })).toEqual(["A+B(1): x"]);
    expect(ids(["P2x3: no"], { id: 1, taskId: "P2.3" })).toEqual([]);
    expect(ids(["anything"], { id: 1, taskId: ".*" })).toEqual([]);
  });
  test("keeps newest-first order of the input", () => {
    expect(ids(["#1 new", "#1 old"], { id: 1, taskId: "" })).toEqual(["#1 new", "#1 old"]);
  });
});

describe("getCommits", () => {
  let root: string;
  const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdin: undefined });
  beforeAll(() => {
    root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "board-git-"));
    mkdirSync(join(root, "repo/plan/board"), { recursive: true });
    mkdirSync(join(root, "plain"));
    git(join(root, "repo"), "init", "-q");
    git(join(root, "repo"), "commit", "-q", "--allow-empty", "-m", "P2.3: first");
    git(join(root, "repo"), "commit", "-q", "--allow-empty", "-m", "second #5");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("reads commits newest first with short hash, author and ISO date, from a subdir", async () => {
    const list = await getCommits(join(root, "repo/plan/board"), { ttl: 0 });
    expect(list.map((x) => x.subject)).toEqual(["second #5", "P2.3: first"]);
    expect(list[0]).toMatchObject({ author: "T" });
    expect(list[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect(list[0].hash.startsWith(list[0].short)).toBe(true);
    expect(list[0].at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
  test("not a git repo, missing dir, and missing git all give []", async () => {
    expect(await getCommits(join(root, "plain"), { ttl: 0 })).toEqual([]);
    expect(await getCommits(join(root, "nope"), { ttl: 0 })).toEqual([]);
    expect(await getCommits(join(root, "repo"), { ttl: 0, bin: "git-does-not-exist" })).toEqual([]);
  });
  test("caches for the ttl", async () => {
    const dir = join(root, "repo");
    const a = await getCommits(dir, { ttl: 60_000 });
    git(dir, "commit", "-q", "--allow-empty", "-m", "third");
    expect(await getCommits(dir, { ttl: 60_000 })).toBe(a);
    expect((await getCommits(dir, { ttl: 0 })).length).toBe(a.length + 1);
  });
  test("huge history is capped at 2000 commits", async () => {
    const big = join(root, "big");
    mkdirSync(big);
    git(big, "init", "-q", "-b", "main");
    let s = "";
    for (let i = 1; i <= 2100; i++) s += `commit refs/heads/main\ncommitter T <t@t> ${1700000000 + i} +0000\ndata 10\nP9.9: ${String(i).padStart(4, "0")}\n\n`;
    Bun.spawnSync(["git", "fast-import", "--quiet"], { cwd: big, stdin: Buffer.from(s) });
    const list = await getCommits(big, { ttl: 0 });
    expect(list).toHaveLength(2000);
    expect(list[0].subject).toBe("P9.9: 2100");
  });
});
