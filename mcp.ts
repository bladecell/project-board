import { randomBytes } from "node:crypto";
import {
  appendNotes, boardDir, cleanOptions, optLabel, claimCard, setSteps, createCard, hasBoard, isAgentLive, loadCards, moveCard, sortCards, startAgent, stopAgent, touchAgents, types, updateCard,
  type Card, type Ctx,
} from "./lib";

export const supportedVersions = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
export const latestVersion = supportedVersions[supportedVersions.length - 1];
export const maxLine = 1024 * 1024;
const caps = { title: 200, description: 10000, notes: 2000, text: 1000, steps: 5000 };

type Json = Record<string, unknown>;
type Reply = { content: { type: "text"; text: string }[]; structuredContent?: Json; isError?: boolean };
class ToolError extends Error {}
const refuse = (m: string): never => { throw new ToolError(m); };

const line = (c: Card) =>
  [String(c.id).padStart(4, "0"), c.column, c.type, c.taskId || "-", c.title,
    c.agent ? `[agent:${c.agent} ${isAgentLive(c) ? "live" : "idle"}]` : ""].filter(Boolean).join("  ");
const brief = (c: Card): Json => ({ id: c.id, column: c.column, type: c.type, taskId: c.taskId, title: c.title, agent: c.agent, agentLive: isAgentLive(c), ...(c.options.length && { answered: !!c.answer }) });

const obj = (props: Json, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const idProp = { type: "integer", minimum: 1, description: "Card id" };
const tools = [
  { name: "board_list", description: "List cards, one per line. Done is hidden unless column is done.", inputSchema: obj({ column: { type: "string", description: "inbox, planned, todo, in-progress, verify or done" } }) },
  { name: "board_show", description: "Show one card in full: fields, description, verify notes, how to verify, history, linked commits.", inputSchema: obj({ id: idProp }, ["id"]) },
  { name: "next_card", description: "Top card in todo that no live agent holds.", inputSchema: obj({}) },
  { name: "claim_card", description: "Take a card from todo, in-progress or verify (rework): moves it to in-progress and marks this agent as working on it.", inputSchema: obj({ id: idProp }, ["id"]) },
  { name: "move_to_verify", description: "Move an in-progress card to verify. Verify notes (what ran and the result) are required. Optional howToVerify: manual checks for the user as `- [ ]` lines, one per check (appended, never replaces). Clears the agent marker.", inputSchema: obj({ id: idProp, notes: { type: "string", maxLength: caps.notes }, howToVerify: { type: "string", maxLength: caps.steps } }, ["id", "notes"]) },
  { name: "set_how_to_verify", description: "Append manual checks to How to verify as `- [ ]` lines, one per check. Only for in-progress or verify cards. Existing text is kept; steps already present are skipped.", inputSchema: obj({ id: idProp, steps: { type: "string", maxLength: caps.steps } }, ["id", "steps"]) },
  { name: "add_card", description: "Create a card in inbox for the user to triage. To ask the user a question, pass options (2 to 12 short choices; write \"Label :: one-line reason\" to explain a choice) and recommended (the label of the option you suggest) and optionally multi: true for a pick-several question. The card becomes a decision the user answers in the board; it moves to done on answer. Read the result with board_show (the Answer section).", inputSchema: obj({ title: { type: "string", maxLength: caps.title }, description: { type: "string", maxLength: caps.description }, type: { type: "string", enum: [...types] }, needsYou: { type: "boolean" }, options: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 12, description: "Choices for the user. Makes the card a decision." }, recommended: { type: "string", maxLength: 300, description: "Label of the option you recommend. Must match an option label." }, multi: { type: "boolean", description: "Let the user pick several options (checkboxes) instead of one (radio)." } }, ["title"]) },
  { name: "add_note", description: "Append a line to a card's verify notes.", inputSchema: obj({ id: idProp, text: { type: "string", maxLength: caps.text } }, ["id", "text"]) },
  { name: "release_card", description: "Clear the agent marker and leave the card in its column.", inputSchema: obj({ id: idProp }, ["id"]) },
];

const text = (s: string, structuredContent?: Json): Reply => ({ content: [{ type: "text", text: s }], ...(structuredContent && { structuredContent }) });

const argId = (a: Json) => {
  const v = typeof a.id === "string" && /^\d{1,9}$/.test(a.id) ? Number(a.id) : a.id;
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : refuse("id must be a positive integer");
};
const argStr = (a: Json, k: keyof typeof caps | string, max: number, required = true) => {
  const v = a[k];
  if (v === undefined || v === null) return required ? refuse(`${k} is required`) : "";
  if (typeof v !== "string") return refuse(`${k} must be a string`);
  const s = v.trim();
  if (required && !s) refuse(`${k} must not be empty`);
  return s.length > max ? refuse(`${k} is longer than ${max} characters`) : s;
};

export function createMcp(root: string, suffix = () => randomBytes(2).toString("hex")) {
  const rand = suffix();
  let client = "agent";
  let label = `agent-${rand}`;
  const dir = boardDir(root);
  const ctx = (): Ctx => ({ by: `mcp:${client}` });

  const find = (id: number) => loadCards(dir).find((c) => c.id === id) ?? refuse(`no card ${id}`);
  const heldByOther = (c: Card) => c.agent && c.agent !== label && isAgentLive(c);
  const guardOther = (c: Card) => { if (heldByOther(c)) refuse(`card ${c.id} is held by another live agent (${c.agent})`); };

  const run: Record<string, (a: Json) => Reply> = {
    board_list(a) {
      const col = argStr(a, "column", 20, false);
      const cards = sortCards(loadCards(dir)).filter((c) => (col ? c.column === col : c.column !== "done"));
      if (col && !["inbox", "planned", "todo", "in-progress", "verify", "done"].includes(col)) refuse(`unknown column "${col}"`);
      return text(cards.length ? cards.map(line).join("\n") : "(no cards)", { cards: cards.map(brief) });
    },
    board_show(a) {
      const c = find(argId(a));
      const { file, ...rest } = c;
      return text(`${line(c)}\n\n${c.description}${c.options.length ? `\n\nOptions (${c.multi ? "pick several" : "pick one"}):\n${c.options.map((o) => `- ${o}${optLabel(o) === c.recommended ? " (recommended)" : ""}`).join("\n")}` : ""}${c.answer ? `\n\nAnswer:\n${c.answer}` : ""}\n\nVerify notes:\n${c.verifyNotes || "(none)"}\n\nHow to verify:\n${c.howToVerify || "(none)"}\n\nHistory:\n${c.history.map((h) => `${h.at} ${h.text} (${h.by})`).join("\n") || "(none)"}`, rest as unknown as Json);
    },
    next_card() {
      const c = sortCards(loadCards(dir)).find((x) => x.column === "todo" && !heldByOther(x));
      return c ? text(line(c), brief(c)) : text("no cards in todo");
    },
    claim_card(a) {
      const c = find(argId(a));
      guardOther(c);
      const out = claimCard(dir, c.id, label, ctx(), true);
      return text(`claimed ${line(out)}`, brief(out));
    },
    move_to_verify(a) {
      const id = argId(a);
      const notes = argStr(a, "notes", caps.notes);
      const steps = argStr(a, "howToVerify", caps.steps, false);
      const c = find(id);
      if (c.column !== "in-progress") refuse(`card ${id} is in ${c.column}; only in-progress cards can move to verify`);
      guardOther(c);
      moveCard(dir, id, "verify", null, notes, ctx(), steps || undefined);
      const out = stopAgent(dir, id, ctx());
      return text(`moved to verify: ${line(out)}`, brief(out));
    },
    set_how_to_verify(a) {
      const id = argId(a);
      const steps = argStr(a, "steps", caps.steps);
      const c = find(id);
      if (c.column !== "in-progress" && c.column !== "verify") refuse(`card ${id} is in ${c.column}; steps can only be added to in-progress or verify cards`);
      guardOther(c);
      const out = setSteps(dir, id, steps, ctx());
      return text(out === c ? `no new steps for ${line(out)}` : `steps added to ${line(out)}`, brief(out));
    },
    add_card(a) {
      const title = argStr(a, "title", caps.title);
      const description = argStr(a, "description", caps.description, false);
      const options = a.options === undefined ? [] : (() => { try { return cleanOptions(a.options); } catch (e) { return refuse((e as Error).message); } })();
      if (a.multi !== undefined && typeof a.multi !== "boolean") refuse("multi must be a boolean");
      if (a.multi === true && options.length < 2) refuse("multi needs at least 2 options");
      if (options.length === 1) refuse("a question needs at least 2 options");
      const recommended = argStr(a, "recommended", 300, false);
      if (recommended && !options.some((o) => optLabel(o) === recommended)) refuse("recommended must match the label of one option");
      const type = a.type === undefined ? (options.length ? "decision" : "task") : a.type;
      if (!(types as readonly unknown[]).includes(type)) refuse(`type must be one of ${types.join(", ")}`);
      if (a.needsYou !== undefined && typeof a.needsYou !== "boolean") refuse("needsYou must be a boolean");
      const c = createCard(dir, { title, description, type, column: "inbox", needsYou: a.needsYou === true || options.length > 0, options, recommended, multi: a.multi === true }, ctx());
      return text(`created ${line(c)}`, brief(c));
    },
    add_note(a) {
      const id = argId(a);
      const t = argStr(a, "text", caps.text);
      const c = find(id);
      const out = updateCard(dir, id, { verifyNotes: appendNotes(c, t).verifyNotes }, ctx());
      return text(`noted on ${line(out)}`, brief(out));
    },
    release_card(a) {
      const c = find(argId(a));
      guardOther(c);
      const out = stopAgent(dir, c.id, ctx());
      return text(c.agent ? `released ${line(out)}` : `card ${c.id} had no agent marker`, brief(out));
    },
  };

  const err = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });

  // Returns the response to send, or null for notifications.
  function handle(msg: unknown): Json | null {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return err(null, -32600, "Invalid Request");
    const m = msg as Json;
    const hasId = typeof m.id === "string" || typeof m.id === "number";
    if (typeof m.method !== "string") return hasId ? err(m.id, -32600, "Invalid Request") : m.id === undefined ? null : err(null, -32600, "Invalid Request");
    if (!hasId) return null;
    const p = m.params && typeof m.params === "object" && !Array.isArray(m.params) ? (m.params as Json) : {};
    switch (m.method) {
      case "initialize": {
        const ci = p.clientInfo as Json | undefined;
        const name = typeof ci?.name === "string" ? ci.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) : "";
        if (name) client = name;
        label = `${client}-${rand}`;
        const v = typeof p.protocolVersion === "string" && supportedVersions.includes(p.protocolVersion) ? p.protocolVersion : latestVersion;
        return ok(m.id, {
          protocolVersion: v,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "board", version: "1.0.0" },
          instructions: "Local kanban board. Use next_card, claim_card, add_note, move_to_verify. Manual checks for the user go in How to verify as `- [ ]` lines (howToVerify / set_how_to_verify), not in notes. To ask the user a question use add_card with options (multi: true for pick-several); read the answer with board_show. Agents cannot move cards to todo, planned or done.",
        });
      }
      case "ping": return ok(m.id, {});
      case "tools/list": return ok(m.id, { tools });
      case "tools/call": {
        const name = p.name;
        if (typeof name !== "string" || !Object.hasOwn(run, name)) return err(m.id, -32602, `Unknown tool: ${String(name).slice(0, 60)}`);
        const args = p.arguments === undefined ? {} : p.arguments;
        if (!args || typeof args !== "object" || Array.isArray(args)) return err(m.id, -32602, "arguments must be an object");
        let reply: Reply;
        try {
          if (!hasBoard(root)) refuse("no board in this project. Run `board init` first.");
          touchAgents(dir, label, new Date(), true);
          reply = run[name](args as Json);
          touchAgents(dir, label, new Date(), true);
        } catch (e) {
          reply = { ...text(e instanceof ToolError ? e.message : `internal error: ${(e as Error).message}`), isError: true };
        }
        return ok(m.id, reply);
      }
      default: return err(m.id, -32601, `Method not found: ${m.method.slice(0, 60)}`);
    }
  }
  return { handle, get label() { return label; } };
}

// Newline-delimited JSON-RPC on stdin/stdout. stdout carries protocol messages only.
export async function runStdio(dir: string) {
  const mcp = createMcp(dir);
  const send = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const onLine = (l: string) => {
    if (!l.trim()) return;
    let msg: unknown;
    try { msg = JSON.parse(l); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    try {
      const r = mcp.handle(msg);
      if (r) send(r);
    } catch (e) {
      console.error(`board mcp: ${(e as Error).message}`);
      send({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
    }
  };
  let buf = "";
  let skipping = false;
  const dec = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (skipping) skipping = false;
      else if (l.length > maxLine) send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } });
      else onLine(l);
    }
    if (buf.length > maxLine) {
      if (!skipping) send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } });
      skipping = true;
      buf = "";
    }
  }
  if (buf.trim() && !skipping) onLine(buf);
}
