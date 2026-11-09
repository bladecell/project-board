import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installMcp, claudeSettings, mcpJson } from "./installmcp";

const scratch = "/tmp/claude-1000/-home-kuba-dev-esp-CAN-Sniffer/0b32f9e8-d0b6-45bf-89f0-a627f3af6ebb/scratchpad";
let root: string;
beforeEach(() => { root = mkdtempSync(join(scratch, "inst-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const rd = (p: string) => readFileSync(join(root, p), "utf8");
const wr = (p: string, s: string) => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), s); };
const touch = { type: "command", command: "board touch", timeout: 5, async: true };

describe("claude", () => {
  test("fresh project creates .mcp.json and settings.local.json", () => {
    const r = installMcp(root, {});
    expect(r.map((x) => x.status)).toEqual(["created", "created"]);
    expect(JSON.parse(rd(".mcp.json"))).toEqual({ mcpServers: { board: { command: "board", args: ["mcp"] } } });
    expect(JSON.parse(rd(".claude/settings.local.json"))).toEqual({ enabledMcpjsonServers: ["board"] });
    expect(rd(".mcp.json")).toBe('{\n  "mcpServers": {\n    "board": {\n      "command": "board",\n      "args": [\n        "mcp"\n      ]\n    }\n  }\n}\n');
    expect(existsSync(join(root, ".claude/settings.json"))).toBe(false);
  });
  test("keeps other servers, other keys and key order", () => {
    wr(".mcp.json", JSON.stringify({ zed: 1, mcpServers: { other: { command: "x" } }, alpha: 2 }));
    wr(".claude/settings.local.json", JSON.stringify({ permissions: { allow: ["Bash"] }, enabledMcpjsonServers: ["other"], model: "m" }));
    installMcp(root, {});
    const m = JSON.parse(rd(".mcp.json"));
    expect(Object.keys(m)).toEqual(["zed", "mcpServers", "alpha"]);
    expect(Object.keys(m.mcpServers)).toEqual(["other", "board"]);
    const s = JSON.parse(rd(".claude/settings.local.json"));
    expect(s).toEqual({ permissions: { allow: ["Bash"] }, enabledMcpjsonServers: ["other", "board"], model: "m" });
    expect(Object.keys(s)).toEqual(["permissions", "enabledMcpjsonServers", "model"]);
  });
  test("an existing board entry is left as the user wrote it", () => {
    wr(".mcp.json", JSON.stringify({ mcpServers: { board: { command: "/opt/board", args: ["mcp"] } } }));
    installMcp(root, {});
    expect(JSON.parse(rd(".mcp.json")).mcpServers.board.command).toBe("/opt/board");
  });
  test("idempotent: second run is unchanged and byte-identical, writes nothing", () => {
    installMcp(root, { hooks: true });
    const a = [rd(".mcp.json"), rd(".claude/settings.local.json")];
    const r = installMcp(root, { hooks: true });
    expect(r.map((x) => x.status)).toEqual(["unchanged", "unchanged"]);
    expect([rd(".mcp.json"), rd(".claude/settings.local.json")]).toEqual(a);
  });
  test("--shared writes .claude/settings.json instead", () => {
    installMcp(root, { shared: true });
    expect(JSON.parse(rd(".claude/settings.json"))).toEqual({ enabledMcpjsonServers: ["board"] });
    expect(existsSync(join(root, ".claude/settings.local.json"))).toBe(false);
  });
  test("--hooks adds the three hooks, keeps other hooks, no duplicates", () => {
    const other = { matcher: "Bash", hooks: [{ type: "command", command: "lint.sh" }] };
    wr(".claude/settings.local.json", JSON.stringify({ hooks: { PostToolUse: [other], Notification: [other] } }));
    installMcp(root, { hooks: true });
    installMcp(root, { hooks: true });
    const h = JSON.parse(rd(".claude/settings.local.json")).hooks;
    expect(h.Notification).toEqual([other]);
    expect(h.PostToolUse).toEqual([other, { matcher: "*", hooks: [touch] }]);
    expect(h.UserPromptSubmit).toEqual([{ hooks: [touch] }]);
    expect(h.Stop).toEqual([{ hooks: [touch] }]);
  });
  test("an existing board touch hook in any group is not duplicated", () => {
    wr(".claude/settings.local.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "board touch" }, { type: "command", command: "x" }] }] } }));
    installMcp(root, { hooks: true });
    expect(JSON.parse(rd(".claude/settings.local.json")).hooks.Stop).toHaveLength(1);
  });
  test("hooks are not added without --hooks", () => {
    installMcp(root, {});
    expect(JSON.parse(rd(".claude/settings.local.json")).hooks).toBeUndefined();
  });
  test("invalid or non-plain JSON is refused and nothing is written, even for other files", () => {
    for (const bad of ['{"a":1,}', '// c\n{"a":1}', "{", "", "[]", "null", '"s"']) {
      wr(".claude/settings.local.json", bad);
      expect(() => installMcp(root, {})).toThrow(/Nothing written|not plain JSON/);
      expect(existsSync(join(root, ".mcp.json"))).toBe(false);
      expect(rd(".claude/settings.local.json")).toBe(bad);
    }
  });
  test("wrong-typed sections are refused", () => {
    wr(".mcp.json", '{"mcpServers": []}');
    expect(() => installMcp(root, {})).toThrow(/not an object/);
    wr(".mcp.json", "{}");
    wr(".claude/settings.local.json", '{"enabledMcpjsonServers": "board"}');
    expect(() => installMcp(root, {})).toThrow(/not an array/);
    wr(".claude/settings.local.json", '{"hooks": {"Stop": {}}}');
    expect(() => installMcp(root, { hooks: true })).toThrow(/not an array/);
  });
  test("dry run reports but writes nothing", () => {
    const r = installMcp(root, { hooks: true }, true);
    expect(r.map((x) => x.status)).toEqual(["created", "created"]);
    expect(r[1].text).toContain("board touch");
    expect(readdirSync(root)).toEqual([]);
  });
  test("no leftover temp files", () => {
    installMcp(root, {});
    expect(readdirSync(root).sort()).toEqual([".claude", ".mcp.json"]);
    expect(readdirSync(join(root, ".claude"))).toEqual(["settings.local.json"]);
  });
});

describe("opencode", () => {
  test("v2 schema by default, preserves $schema and other keys", () => {
    wr("opencode.json", JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "m", mcp: { servers: { a: { type: "remote", url: "u" } } } }));
    installMcp(root, { target: "opencode" });
    const o = JSON.parse(rd("opencode.json"));
    expect(o).toEqual({ $schema: "https://opencode.ai/config.json", model: "m", mcp: { servers: { a: { type: "remote", url: "u" }, board: { type: "local", command: ["board", "mcp"] } } } });
    expect(Object.keys(o)).toEqual(["$schema", "model", "mcp"]);
  });
  test("v1 schema behind the flag", () => {
    installMcp(root, { target: "opencode", v1: true });
    expect(JSON.parse(rd("opencode.json"))).toEqual({ mcp: { board: { type: "local", command: ["board", "mcp"], enabled: true } } });
  });
  test("fresh, idempotent, refuses invalid", () => {
    expect(installMcp(root, { target: "opencode" })[0].status).toBe("created");
    const a = rd("opencode.json");
    expect(installMcp(root, { target: "opencode" })[0].status).toBe("unchanged");
    expect(rd("opencode.json")).toBe(a);
    wr("opencode.json", '{"mcp": {},}');
    expect(() => installMcp(root, { target: "opencode" })).toThrow();
    expect(rd("opencode.json")).toBe('{"mcp": {},}');
  });
});

test("pure helpers return text only", () => {
  expect(mcpJson(null)).toContain("board");
  expect(claudeSettings(null, false)).toBe('{\n  "enabledMcpjsonServers": [\n    "board"\n  ]\n}\n');
});
