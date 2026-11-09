import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("agent commands", () => {
  afterAll(() => { board("stop", "1"); board("move", "1", "inbox"); });
  const run = (stdin: string | undefined, ...a: string[]) => {
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "--dir", root, ...a], { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) });
    return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode };
  };
  const agentOf = () => /^agent: (.*)$/m.exec(board("show", "1"))?.[1];

  test("start, touch by hook payload prefix, show, stop", () => {
    board("move", "1", "in-progress");
    board("start", "1", "--session", "abcdef123456");
    expect(agentOf()).toBe("abcdef12");
    expect(board("show", "1")).toMatch(/· agent started · cli$/m);
    expect(board("list")).toContain("agent:abcdef12");
    const t = run(JSON.stringify({ session_id: "abcdef12-9999-aaaa", hook_event_name: "Stop" }), "touch");
    expect(t).toEqual({ out: "", err: "", code: 0 });
    expect(board("stop", "1")).toContain("0001");
    expect(agentOf()).toBeUndefined();
    expect(board("show", "1")).toMatch(/· agent stopped · cli$/m);
  });

  test("moving to verify clears the marker; stop afterwards adds nothing; list shows no agent", () => {
    board("start", "1", "--session", "movetest1");
    board("move", "1", "verify", "--notes", "ran");
    expect(agentOf()).toBeUndefined();
    expect(board("list")).not.toContain("agent:");
    expect((board("show", "1").match(/agent stopped/g) ?? []).length).toBeGreaterThanOrEqual(1);
    board("stop", "1");
    board("move", "1", "in-progress");
  });

  test("touch never fails or prints: garbage, empty, oversized, no stdin, no board", () => {
    board("start", "1", "--session", "keepme01");
    for (const input of ["not json", "", "[1,2]", "null", JSON.stringify({ session_id: 42 }), "x".repeat(300_000), JSON.stringify({ session_id: "nomatch00" })]) {
      expect(run(input, "touch")).toEqual({ out: "", err: "", code: 0 });
    }
    expect(run(undefined, "touch")).toEqual({ out: "", err: "", code: 0 });
    expect(Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "--dir", join(root, "missing"), "touch"], { stdin: "ignore" }).exitCode).toBe(0);
    expect(agentOf()).toBe("keepme01");
  });

  test("start without --session uses CLAUDE_SESSION_ID, then claude", () => {
    board("stop", "1");
    Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "--dir", root, "start", "1"], { env: { ...process.env, CLAUDE_SESSION_ID: "envid12345" } });
    expect(agentOf()).toBe("envid123");
    board("stop", "1");
    Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "--dir", root, "start", "1"], { env: { ...process.env, CLAUDE_SESSION_ID: "" } });
    expect(agentOf()).toBe("claude");
  });

  test("commands find the board from a subdirectory", () => {
    mkdirSync(join(root, "sub/deep"), { recursive: true });
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "list"], { cwd: join(root, "sub/deep") });
    expect(r.stdout.toString()).toContain("0001");
  });
});

describe("mcp-config", () => {
  const cfg = (w: string) => JSON.parse(Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "--dir", root, "mcp-config", w]).stdout.toString());
  test("prints valid JSON for each client", () => {
    expect(cfg("claude")).toEqual({ mcpServers: { board: { command: "board", args: ["mcp"] } } });
    expect(cfg("opencode").mcp.servers.board).toEqual({ type: "local", command: ["board", "mcp"] });
    expect(cfg("opencode-v1").mcp.board).toMatchObject({ type: "local", command: ["board", "mcp"], enabled: true });
    expect(Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "mcp-config", "x"]).exitCode).toBe(1);
  });
});

describe("install-mcp command", () => {
  test("writes files, reports, is idempotent; dry-run writes nothing; init does not install", () => {
    const p = mkdtempSync(join(root, "ip-"));
    const run = (...a: string[]) => { const r = Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "--dir", p, ...a]); return { out: r.stdout.toString(), code: r.exitCode }; };
    run("init");
    expect(Bun.file(join(p, ".mcp.json")).size).toBe(0);
    expect(run("install-mcp", "--dry-run").out).toContain("would create: .mcp.json");
    expect(Bun.file(join(p, ".mcp.json")).size).toBe(0);
    expect(run("install-mcp", "--hooks").out).toContain("created: .claude/settings.local.json");
    expect(run("install-mcp", "--hooks").out).toContain("already configured: .mcp.json");
    writeFileSync(join(p, "opencode.json"), "{,}");
    const bad = run("install-mcp", "opencode");
    expect(bad.code).toBe(1);
  });
});

test("prompt prints the instruction for a card", () => {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "--dir", root, "prompt", "1"]);
  expect(r.stdout.toString()).toMatch(/^Look at board card #1: ".*"\. It is not approved yet\./);
  expect(Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "--dir", root, "prompt", "999"]).exitCode).toBe(1);
});

describe("steps", () => {
  const run = (stdin: string | undefined, ...a: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "--dir", root, ...a], { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) });
  const how = () => /## How to verify\n([\s\S]*?)(\n## |\n*$)/.exec(board("show", "1"))?.[1];
  test("move --steps splits literal \\n and flattened items; steps via flag and stdin append without duplicates", () => {
    board("add", "stepper", "--column", "in-progress");
    const id = /^(\d+)/.exec(board("list", "in-progress").split("\n").find((l) => l.includes("stepper"))!)![1];
    const sh = (...a: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "--dir", root, ...a]);
    expect(sh("move", id, "verify", "--notes", "ran it", "--steps", "- [ ] a\\n- [ ] b - [ ] c").exitCode).toBe(0);
    expect(sh("steps", id, "--steps", "- [ ] c\n- [ ] d").exitCode).toBe(0);
    expect(run("- [ ] e\n- [ ] a\n", "steps", id).exitCode).toBe(0);
    const shown = board("show", id);
    expect(shown).toContain("## How to verify\n- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n- [ ] e\n");
    expect(shown).toContain("verify steps added");
    expect(run(undefined, "steps", id).exitCode).toBe(1);
    void how;
  });
});
