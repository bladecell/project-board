import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
beforeAll(() => { root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "board-cli-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const board = (...a: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "--dir", root, ...a]).stdout.toString();

test("show prints created, updated and cli-sourced history", () => {
  board("init");
  board("add", "hello");
  board("move", "1", "verify", "--notes", "ran it");
  const out = board("show", "1");
  expect(out).toMatch(/^created: \d{4}-\d\d-\d\dT[\d:]+Z$/m);
  expect(out).toMatch(/^updated: \d{4}-\d\d-\d\dT[\d:]+Z$/m);
  expect(out).toMatch(/^## History$/m);
  expect(out).toMatch(/· created · cli$/m);
  expect(out).toMatch(/· moved inbox → verify · cli$/m);
  expect(out).toMatch(/· verify notes updated · cli$/m);
});

test("show lists linked commits from git", () => {
  const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd: root });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "fix thing #1");
  const out = board("show", "1");
  expect(out).toMatch(/^Commits \(1\)$/m);
  expect(out).toMatch(/^[0-9a-f]{7}  \d{4}-\d\d-\d\d  fix thing #1$/m);
});

test("subtasks converts the description and is idempotent", () => {
  board("add", "sub");
  const id = "2";
  const path = join(root, "board/cards/0002-sub.md");
  const text = readFileSync(path, "utf8").replace("title: sub\n---\n", "title: sub\n---\n\n- one\n- two\n");
  writeFileSync(path, text);
  expect(board("subtasks", id)).toContain("converted");
  const shown = board("show", id);
  expect(shown).toContain("- [ ] one\n- [ ] two");
  expect(shown).toMatch(/· converted list to subtasks · cli$/m);
  expect(board("subtasks", id)).toContain("nothing to convert");
});
