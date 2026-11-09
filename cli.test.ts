import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
