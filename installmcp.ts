import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "./lib";

type Obj = Record<string, any>;
export type Opts = { target?: "claude" | "opencode"; hooks?: boolean; shared?: boolean; v1?: boolean };
export type FileResult = { path: string; status: "created" | "updated" | "unchanged"; text: string };

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

// Plain JSON only: comments, trailing commas and non-object roots are refused.
function parse(text: string | null, path: string): Obj {
  if (text === null) return {};
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { throw new Error(`${path} is not plain JSON (${(e as Error).message}). Nothing written; fix or merge it by hand (see \`board mcp-config\`).`); }
  if (!isObj(v)) throw new Error(`${path} must contain a JSON object. Nothing written.`);
  return v;
}
const child = (o: Obj, k: string, path: string): Obj => {
  if (o[k] === undefined) o[k] = {};
  if (!isObj(o[k])) throw new Error(`${path}: "${k}" is not an object. Nothing written.`);
  return o[k];
};
const out = (o: Obj) => `${JSON.stringify(o, null, 2)}\n`;

export const mcpJson = (text: string | null, path = ".mcp.json") => {
  const o = parse(text, path);
  const s = child(o, "mcpServers", path);
  s.board ??= { command: "board", args: ["mcp"] };
  return out(o);
};

export const opencodeJson = (text: string | null, v1 = false, path = "opencode.json") => {
  const o = parse(text, path);
  const mcp = child(o, "mcp", path);
  if (v1) mcp.board ??= { type: "local", command: ["board", "mcp"], enabled: true };
  else child(mcp, "servers", path).board ??= { type: "local", command: ["board", "mcp"] };
  return out(o);
};

const touchHook = { type: "command", command: "board touch", timeout: 5, async: true };
const hookEvents: [string, string | undefined][] = [["UserPromptSubmit", undefined], ["PostToolUse", "*"], ["Stop", undefined]];

export const claudeSettings = (text: string | null, hooks: boolean, path = ".claude/settings.local.json") => {
  const o = parse(text, path);
  if (o.enabledMcpjsonServers === undefined) o.enabledMcpjsonServers = [];
  if (!Array.isArray(o.enabledMcpjsonServers)) throw new Error(`${path}: "enabledMcpjsonServers" is not an array. Nothing written.`);
  if (!o.enabledMcpjsonServers.includes("board")) o.enabledMcpjsonServers.push("board");
  if (hooks) {
    const h = child(o, "hooks", path);
    for (const [ev, matcher] of hookEvents) {
      if (h[ev] === undefined) h[ev] = [];
      if (!Array.isArray(h[ev])) throw new Error(`${path}: hooks.${ev} is not an array. Nothing written.`);
      const has = h[ev].some((g: unknown) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some((x: unknown) => isObj(x) && x.type === "command" && x.command === touchHook.command));
      if (!has) h[ev].push({ ...(matcher && { matcher }), hooks: [{ ...touchHook }] });
    }
  }
  return out(o);
};

export function onPath(bin: string, pathVar = process.env.PATH ?? "") {
  return pathVar.split(":").some((d) => d && existsSync(join(d, bin)));
}

// Computes every file first; throws before writing anything if one is unusable.
export function installMcp(root: string, o: Opts, dryRun = false): FileResult[] {
  const plan: [string, (t: string | null, p: string) => string][] = o.target === "opencode"
    ? [["opencode.json", (t, p) => opencodeJson(t, o.v1, p)]]
    : [[".mcp.json", mcpJson], [o.shared ? ".claude/settings.json" : ".claude/settings.local.json", (t, p) => claudeSettings(t, !!o.hooks, p)]];
  const results = plan.map(([rel, fn]) => {
    const path = join(root, rel);
    const old = existsSync(path) ? readFileSync(path, "utf8") : null;
    const text = fn(old, rel);
    const status: FileResult["status"] = old === null ? "created" : old === text ? "unchanged" : "updated";
    return { path, status, text };
  });
  if (!dryRun) {
    for (const r of results) {
      if (r.status === "unchanged") continue;
      mkdirSync(dirname(r.path), { recursive: true });
      atomicWrite(r.path, r.text);
    }
  }
  return results;
}
