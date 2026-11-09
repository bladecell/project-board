import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardDir, createCard, initBoard, loadCards, moveCard, startAgent } from "./lib";
import { createMcp, latestVersion, supportedVersions } from "./mcp";

const scratch = "/tmp/claude-1000/-home-kuba-dev-esp-CAN-Sniffer/0b32f9e8-d0b6-45bf-89f0-a627f3af6ebb/scratchpad";
let root: string, dir: string;
const ui = { by: "ui" as const };
const rpc = (m: ReturnType<typeof createMcp>, method: string, params?: unknown, id: number | string = 1) => m.handle({ jsonrpc: "2.0", id, method, params }) as any;
const call = (m: ReturnType<typeof createMcp>, name: string, args?: unknown) => rpc(m, "tools/call", { name, arguments: args }).result;
const card = (id: number) => loadCards(dir).find((c) => c.id === id)!;
const mk = (title: string, column: string) => {
  const c = createCard(dir, { title }, ui);
  return column === "inbox" ? c : moveCard(dir, c.id, column as never, null, undefined, ui);
};
const hello = (name = "claude-code") => {
  const m = createMcp(root, () => "ab12");
  rpc(m, "initialize", { protocolVersion: latestVersion, clientInfo: { name }, capabilities: {} });
  return m;
};

beforeEach(() => {
  root = mkdtempSync(join(scratch, "mcp-test-"));
  initBoard(root);
  dir = boardDir(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("protocol", () => {
  test("initialize echoes a supported version, falls back to latest, reports tools capability", () => {
    const m = createMcp(root);
    expect(rpc(m, "initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "x" } }).result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "board" } });
    expect(rpc(m, "initialize", { protocolVersion: "1999-01-01" }).result.protocolVersion).toBe(latestVersion);
    expect(rpc(m, "initialize").result.protocolVersion).toBe(latestVersion);
    expect(supportedVersions).toContain(latestVersion);
  });
  test("notifications get no response, ping answers, unknown methods error", () => {
    const m = createMcp(root);
    expect(m.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(m.handle({ jsonrpc: "2.0", method: "nope/whatever" })).toBeNull();
    expect(rpc(m, "ping").result).toEqual({});
    expect(rpc(m, "resources/list").error.code).toBe(-32601);
    expect(rpc(m, "x", undefined, "str-id").id).toBe("str-id");
  });
  test("invalid requests are JSON-RPC errors, never throws", () => {
    const m = createMcp(root);
    for (const bad of [null, 5, "x", [], [1, 2], {}, { id: 1 }, { id: 1, method: 7 }, { jsonrpc: "2.0", id: {}, method: "ping" }]) {
      expect(() => m.handle(bad)).not.toThrow();
    }
    expect((m.handle(null) as any).error.code).toBe(-32600);
    expect((m.handle({ id: 1 }) as any).error.code).toBe(-32600);
  });
  test("tools/list names the nine tools with object schemas", () => {
    const tools = rpc(createMcp(root), "tools/list").result.tools;
    expect(tools.map((t: any) => t.name).sort()).toEqual(["add_card", "add_note", "board_list", "board_show", "claim_card", "move_to_verify", "next_card", "release_card", "set_how_to_verify"]);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });
  test("unknown tool and bad arguments are protocol errors", () => {
    const m = hello();
    expect(rpc(m, "tools/call", { name: "delete_card", arguments: {} }).error.code).toBe(-32602);
    expect(rpc(m, "tools/call", { name: "__proto__" }).error.code).toBe(-32602);
    expect(rpc(m, "tools/call", { name: "constructor" }).error.code).toBe(-32602);
    expect(rpc(m, "tools/call", {}).error.code).toBe(-32602);
    expect(rpc(m, "tools/call", { name: "board_list", arguments: [1] }).error.code).toBe(-32602);
  });
  test("no board gives a clear tool error", () => {
    const empty = mkdtempSync(join(scratch, "mcp-empty-"));
    try {
      const r = call(createMcp(empty), "board_list", {});
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("board init");
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});

describe("tools", () => {
  test("board_list hides done, filters, rejects unknown columns", () => {
    mk("a", "todo"); mk("b", "done");
    const m = hello();
    expect(call(m, "board_list", {}).content[0].text).toContain("a");
    expect(call(m, "board_list", {}).content[0].text).not.toContain("  b");
    expect(call(m, "board_list", { column: "done" }).structuredContent.cards).toHaveLength(1);
    expect(call(m, "board_list", { column: "bogus" }).isError).toBe(true);
    expect(call(m, "board_list", { column: 5 }).isError).toBe(true);
  });
  test("board_show returns the card and fails for unknown ids", () => {
    const c = mk("shown", "todo");
    const m = hello();
    expect(call(m, "board_show", { id: c.id }).content[0].text).toContain("shown");
    expect(call(m, "board_show", { id: 99 }).isError).toBe(true);
    for (const id of [0, -1, 1.5, "x", null, {}, undefined]) expect(call(m, "board_show", { id }).isError).toBe(true);
    expect(call(m, "board_show", { id: String(c.id) }).isError).toBeUndefined();
  });
  test("next_card returns the top todo card not held by a live agent", () => {
    const a = mk("first", "todo"); const b = mk("second", "todo");
    mk("inbox one", "inbox");
    const m = hello();
    expect(call(m, "next_card", {}).structuredContent.id).toBe(a.id);
    startAgent(dir, a.id, "someone-else", ui, true);
    expect(call(m, "next_card", {}).structuredContent.id).toBe(a.id);
    moveCard(dir, a.id, "done", null, undefined, ui);
    moveCard(dir, b.id, "done", null, undefined, ui);
    expect(call(m, "next_card", {}).content[0].text).toBe("no cards in todo");
  });
  test("claim moves todo to in-progress, marks the agent, tags history mcp:<client>", () => {
    const c = mk("work", "todo");
    const m = hello("Claude Code");
    const r = call(m, "claim_card", { id: c.id });
    expect(r.isError).toBeUndefined();
    const got = card(c.id);
    expect(got).toMatchObject({ column: "in-progress", agent: "claude-code-ab12" });
    expect(isoLive(got.agentAt)).toBe(true);
    expect(got.history.map((h) => [h.text, h.by]).slice(-2)).toEqual([["moved todo → in-progress", "mcp:claude-code"], ["agent started", "mcp:claude-code"]]);
    expect(readFileSync(join(dir, "cards", got.file), "utf8")).toContain("· mcp:claude-code");
  });
  test("claim works on in-progress, refuses other columns and live holders, takes over stale ones", () => {
    const m = hello();
    const ip = mk("ip", "in-progress");
    expect(call(m, "claim_card", { id: ip.id }).isError).toBeUndefined();
    for (const col of ["inbox", "planned", "done"]) {
      const c = mk(`in ${col}`, col);
      expect(call(m, "claim_card", { id: c.id }).isError).toBe(true);
      expect(card(c.id).column).toBe(col);
    }
    const held = mk("held", "in-progress");
    startAgent(dir, held.id, "opencode-zzzz", ui, true);
    expect(call(m, "claim_card", { id: held.id }).isError).toBe(true);
    expect(card(held.id)).toMatchObject({ column: "in-progress", agent: "opencode-zzzz" });
    const stale = mk("stale", "in-progress");
    startAgent(dir, stale.id, "gone", { by: "cli", now: new Date(Date.now() - 6 * 60000) }, true);
    expect(call(m, "claim_card", { id: stale.id }).isError).toBeUndefined();
    expect(card(stale.id).agent).toBe("claude-code-ab12");
  });
  test("move_to_verify needs in-progress, notes, and clears the marker", () => {
    const m = hello();
    const c = mk("w", "todo");
    expect(call(m, "move_to_verify", { id: c.id, notes: "x" }).isError).toBe(true);
    call(m, "claim_card", { id: c.id });
    expect(call(m, "move_to_verify", { id: c.id }).isError).toBe(true);
    expect(call(m, "move_to_verify", { id: c.id, notes: "   " }).isError).toBe(true);
    expect(call(m, "move_to_verify", { id: c.id, notes: "x".repeat(2001) }).isError).toBe(true);
    expect(card(c.id).column).toBe("in-progress");
    expect(call(m, "move_to_verify", { id: c.id, notes: "ran tests, 12 pass" }).isError).toBeUndefined();
    const got = card(c.id);
    expect(got).toMatchObject({ column: "verify", agent: "", agentAt: "" });
    expect(got.verifyNotes).toContain("ran tests, 12 pass");
    expect(got.history.at(-1)).toMatchObject({ text: "agent stopped", by: "mcp:claude-code" });
  });
  test("move_to_verify refuses a card held by another live agent", () => {
    const c = mk("w", "in-progress");
    startAgent(dir, c.id, "other-1", ui, true);
    expect(call(hello(), "move_to_verify", { id: c.id, notes: "n" }).isError).toBe(true);
    expect(card(c.id).column).toBe("in-progress");
  });
  test("add_card creates in inbox only and validates input", () => {
    const m = hello();
    const r = call(m, "add_card", { title: "found a bug", description: "details", type: "bug", needsYou: true });
    expect(card(r.structuredContent.id)).toMatchObject({ column: "inbox", type: "bug", needsYou: true, description: "details" });
    expect(card(r.structuredContent.id).history[0].by).toBe("mcp:claude-code");
    const sneaky = call(m, "add_card", { title: "x", column: "todo", phase: "p", lane: "l", blocked: true });
    expect(card(sneaky.structuredContent.id)).toMatchObject({ column: "inbox", phase: "", lane: "", blocked: false });
    for (const a of [{}, { title: "" }, { title: "  " }, { title: 5 }, { title: "x".repeat(201) }, { title: "x", type: "nope" }, { title: "x", description: "d".repeat(10001) }, { title: "x", needsYou: "yes" }]) {
      expect(call(m, "add_card", a).isError).toBe(true);
    }
    expect(loadCards(dir)).toHaveLength(2);
  });
  test("add_note appends to verify notes with a history line and validates", () => {
    const c = mk("n", "in-progress");
    const m = hello();
    expect(call(m, "add_note", { id: c.id, text: "first" }).isError).toBeUndefined();
    call(m, "add_note", { id: c.id, text: "second\nline" });
    const got = card(c.id);
    expect(got.verifyNotes.split("\n")).toHaveLength(3);
    expect(got.verifyNotes).toContain("first");
    expect(got.history.filter((h) => h.text === "verify notes updated")).toHaveLength(2);
    expect(got.column).toBe("in-progress");
    for (const a of [{ id: c.id }, { id: c.id, text: "" }, { id: c.id, text: "x".repeat(1001) }, { id: 99, text: "x" }]) expect(call(m, "add_note", a).isError).toBe(true);
  });
  test("release clears only own or stale markers and keeps the column", () => {
    const m = hello();
    const c = mk("r", "todo");
    call(m, "claim_card", { id: c.id });
    expect(call(m, "release_card", { id: c.id }).isError).toBeUndefined();
    expect(card(c.id)).toMatchObject({ column: "in-progress", agent: "" });
    const other = mk("o", "in-progress");
    startAgent(dir, other.id, "other-1", ui, true);
    expect(call(m, "release_card", { id: other.id }).isError).toBe(true);
    expect(card(other.id).agent).toBe("other-1");
    expect(call(m, "release_card", { id: mk("none", "todo").id }).isError).toBeUndefined();
  });
  test("heartbeat: every call refreshes agentAt of this server's cards, not updated or history", () => {
    const c = mk("hb", "todo");
    const m = hello();
    call(m, "claim_card", { id: c.id });
    const old = new Date(Date.now() - 4 * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const file = join(dir, "cards", card(c.id).file);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^agentAt: .*$/m, `agentAt: ${old}`));
    const before = card(c.id);
    call(m, "board_list", {});
    const after = card(c.id);
    expect(Date.parse(after.agentAt)).toBeGreaterThan(Date.parse(old) + 60000);
    expect(after.updated).toBe(before.updated);
    expect(after.history).toEqual(before.history);
  });
});

describe("claim parity with board start", () => {
  test("verify goes back to in-progress for rework; inbox/planned say the card is not approved", () => {
    const m = hello();
    const v = mk("rework", "verify");
    expect(call(m, "claim_card", { id: v.id }).isError).toBeUndefined();
    expect(card(v.id)).toMatchObject({ column: "in-progress", agent: "claude-code-ab12" });
    for (const col of ["inbox", "planned"]) expect(call(m, "claim_card", { id: mk(col, col).id }).content[0].text).toContain("not approved");
  });
});

describe("how to verify", () => {
  test("set_how_to_verify appends deduped steps in in-progress and verify only", () => {
    const m = hello();
    const c = mk("s", "in-progress");
    writeFileSync(join(dir, "cards", c.file), readFileSync(join(dir, "cards", c.file), "utf8") + "\n## How to verify\nuser text\n");
    const r = call(m, "set_how_to_verify", { id: c.id, steps: "- [ ] a - [ ] b" });
    expect(r.isError).toBeUndefined();
    call(m, "set_how_to_verify", { id: c.id, steps: "- [ ] b\n- [ ] c" });
    expect(card(c.id).howToVerify).toBe("user text\n- [ ] a\n- [ ] b\n- [ ] c");
    expect(card(c.id).history.filter((h) => h.text === "verify steps added").map((h) => h.by)).toEqual(["mcp:claude-code", "mcp:claude-code"]);
    for (const col of ["inbox", "planned", "todo", "done"]) {
      const o = mk(`o ${col}`, col);
      expect(call(m, "set_how_to_verify", { id: o.id, steps: "- [ ] x" }).isError).toBe(true);
      expect(card(o.id).howToVerify).toBe("");
    }
    const v = mk("v", "verify");
    expect(call(m, "set_how_to_verify", { id: v.id, steps: "- [ ] x" }).isError).toBeUndefined();
    for (const a of [{ id: c.id }, { id: c.id, steps: "" }, { id: c.id, steps: "x".repeat(5001) }, { id: 99, steps: "x" }]) expect(call(m, "set_how_to_verify", a).isError).toBe(true);
  });
  test("move_to_verify accepts howToVerify", () => {
    const m = hello();
    const c = mk("w", "todo");
    call(m, "claim_card", { id: c.id });
    expect(call(m, "move_to_verify", { id: c.id, notes: "ran", howToVerify: "- [ ] phone - [ ] desktop" }).isError).toBeUndefined();
    expect(card(c.id)).toMatchObject({ column: "verify", howToVerify: "- [ ] phone\n- [ ] desktop" });
    expect(card(c.id).verifyNotes).not.toContain("[ ]");
  });
});

describe("hard rules: agents cannot", () => {
  test("move anything to done, planned or todo, or out of inbox, or delete, or edit user fields", () => {
    const m = hello();
    const inbox = mk("i", "inbox"); const todo = mk("t", "todo"); const ip = mk("p", "in-progress"); const ver = mk("v", "verify"); const done = mk("d", "done");
    const names = ["move_card", "move", "delete_card", "update_card", "edit_card", "set_column", "claim_card"];
    for (const n of names.slice(0, 6)) expect(rpc(m, "tools/call", { name: n, arguments: { id: todo.id, column: "done" } }).error.code).toBe(-32602);
    for (const c of [inbox, done]) expect(call(m, "claim_card", { id: c.id }).isError).toBe(true);
    for (const c of [inbox, todo, ver, done]) expect(call(m, "move_to_verify", { id: c.id, notes: "n" }).isError).toBe(true);
    // extra arguments that try to change user-owned fields are ignored
    call(m, "claim_card", { id: ip.id, column: "done", title: "hacked", phase: "x", needsYou: true, blocked: true });
    call(m, "add_note", { id: ip.id, text: "n", title: "hacked", column: "done", lane: "x" });
    call(m, "move_to_verify", { id: ip.id, notes: "ok", column: "done", title: "hacked" });
    expect(card(ip.id)).toMatchObject({ column: "verify", title: "p", phase: "", lane: "", needsYou: false, blocked: false });
    expect(card(inbox.id).column).toBe("inbox");
    expect(card(done.id).column).toBe("done");
    expect(loadCards(dir)).toHaveLength(5);
  });
});

function isoLive(at: string) { return Date.now() - Date.parse(at) < 60000; }

describe("init writes the workflow block into AGENTS.md too", () => {
  test("appends, refreshes in place, idempotent, missing file stays missing", () => {
    expect(initBoard(root).agents).toBe("missing");
    writeFileSync(join(root, "AGENTS.md"), "# Agents\n\nhello\n");
    expect(initBoard(root).agents).toBe("appended");
    const a = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(a).toContain("## Board workflow");
    expect(a).toContain("claim_card");
    expect(a).toContain("board start <id>");
    expect(initBoard(root).agents).toBe("present");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(a);
    writeFileSync(join(root, "AGENTS.md"), a.replace("## Board workflow", "## Board workflow\nstale line"));
    expect(initBoard(root).agents).toBe("updated");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(a);
  });
});
