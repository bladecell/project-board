import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardDir, createCard, initBoard, startAgent } from "./lib";
import { startServer } from "./server";

let root: string, srv: ReturnType<typeof startServer>, base: string;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const post = (path: string, body: BodyInit, type = "application/json") =>
  fetch(base + path, { method: "POST", headers: { "content-type": type }, body });

beforeAll(() => {
  root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "board-srv-"));
  initBoard(root);
  srv = startServer(boardDir(root), 0, "t");
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(() => { srv.close(); rmSync(root, { recursive: true, force: true }); });

describe("server", () => {
  test("create, list, move, update, delete", async () => {
    const c = await (await post("/api/cards", JSON.stringify({ title: "hello" }))).json();
    expect(c).toMatchObject({ id: 1, column: "inbox" });
    const moved = await (await post("/api/cards/1/move", JSON.stringify({ column: "todo" }))).json();
    expect(moved.column).toBe("todo");
    const put = await fetch(`${base}/api/cards/1`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ blocked: true }) });
    expect((await put.json()).blocked).toBe(true);
    expect((await (await fetch(`${base}/api/cards`)).json())).toHaveLength(1);
    expect((await fetch(`${base}/api/cards/1`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${base}/api/cards/1`, { method: "DELETE" })).status).toBe(404);
  });

  test("bad input is 4xx, never 500", async () => {
    expect((await post("/api/cards", "{nope")).status).toBe(400);
    expect((await post("/api/cards", JSON.stringify({ title: "x", column: "zzz" }))).status).toBe(400);
    expect((await post("/api/cards", "title=x", "text/plain")).status).toBe(415);
    expect((await post("/api/cards/abc/move", "{}")).status).toBe(404);
    expect((await post("/api/cards/99/move", JSON.stringify({ column: "todo" }))).status).toBe(404);
  });

  test("image upload, fetch, type and size limits", async () => {
    const up = await post("/api/images", png, "image/png");
    expect(up.status).toBe(201);
    const { url } = await up.json();
    const got = await fetch(`${base}/${url}`);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png);
    expect((await post("/api/images", "<svg/>", "image/svg+xml")).status).toBe(415);
    expect((await post("/api/images", new Uint8Array(10 * 1024 * 1024 + 1), "image/png")).status).toBe(413);
    expect(readdirSync(join(boardDir(root), "images"))).toHaveLength(1);
  });

  test("path traversal is rejected", async () => {
    for (const p of ["/images/..%2f..%2fcards%2f0001-x.md", "/images/../cards/x.md", "/images/%2e%2e/x.png", "/images/a.png/../../x", "/images/.hidden.png", "/images/a%00.png", "/api/cards/..%2f1"]) {
      const res = await fetch(base + p);
      expect([400, 404]).toContain(res.status);
    }
  });

  test("foreign Host and Origin are refused", async () => {
    expect((await fetch(base + "/api/cards", { headers: { host: "evil.test" } })).status).toBe(403);
    const res = await fetch(base + "/api/cards", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.test" }, body: JSON.stringify({ title: "x" }) });
    expect(res.status).toBe(403);
  });

  test("API returns history, source ui, and ignores client history/timestamps", async () => {
    const c = await (await post("/api/cards", JSON.stringify({ title: "h", created: "2000-01-01T00:00:00Z", history: [{ at: "x", text: "forged", by: "cli" }] }))).json();
    expect(c.created).not.toBe("2000-01-01T00:00:00Z");
    expect(c.history).toMatchObject([{ text: "created", by: "ui" }]);
    const put = await fetch(`${base}/api/cards/${c.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ phase: "P9", history: [], updated: "1999-01-01T00:00:00Z" }) });
    const u = await put.json();
    expect(u.history.map((h: { text: string }) => h.text)).toEqual(["created", "phase (none) → P9"]);
    expect(u.updated).not.toBe("1999-01-01T00:00:00Z");
    expect(u).not.toHaveProperty("file");
    const mv = await (await post(`/api/cards/${c.id}/move`, JSON.stringify({ column: "verify" }))).json();
    expect(mv.history.at(-1)).toMatchObject({ text: "moved inbox → verify", by: "ui" });
    const noop = await (await post(`/api/cards/${c.id}/move`, JSON.stringify({ column: "verify" }))).json();
    expect(noop.history).toHaveLength(3);
  });
});

describe("commit links", () => {
  let groot: string, gsrv: ReturnType<typeof startServer>, gbase: string;
  const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd: groot });
  beforeAll(() => {
    groot = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "board-srvgit-"));
    git("init", "-q");
    initBoard(groot);
    for (const t of ["one", "two"]) createCard(boardDir(groot), { title: t, ...(t === "one" ? { taskId: "P2.3" } : {}) }, { by: "cli" });
    git("commit", "-q", "--allow-empty", "-m", "P2.3: first");
    git("commit", "-q", "--allow-empty", "-m", "P2.30: other");
    git("commit", "-q", "--allow-empty", "-m", "P2.3 and #2");
    gsrv = startServer(boardDir(groot), 0, "g");
    gbase = `http://127.0.0.1:${gsrv.port}`;
  });
  afterAll(() => { gsrv.close(); rmSync(groot, { recursive: true, force: true }); });

  test("list has commitCount, detail has newest-first commits", async () => {
    const list = await (await fetch(`${gbase}/api/cards`)).json();
    expect(list.map((c: { commitCount: number }) => c.commitCount)).toEqual([2, 1]);
    expect(list[0]).not.toHaveProperty("commits");
    const one = await (await fetch(`${gbase}/api/cards/1`)).json();
    expect(one.commits.map((c: { subject: string }) => c.subject)).toEqual(["P2.3 and #2", "P2.3: first"]);
    expect(Object.keys(one.commits[0]).sort()).toEqual(["at", "author", "hash", "short", "subject"]);
    expect((await fetch(`${gbase}/api/cards/99`)).status).toBe(404);
  });

  test("outside a git repo commits are empty, not an error", async () => {
    const c = await (await fetch(`${base}/api/cards`)).json();
    expect(Array.isArray(c)).toBe(true);
    const made = await (await post("/api/cards", JSON.stringify({ title: "ng" }))).json();
    const d = await (await fetch(`${base}/api/cards/${made.id}`)).json();
    expect(d).toMatchObject({ commitCount: 0, commits: [] });
  });

  test("cards expose tasksDone and tasksTotal, computed not stored", async () => {
    const c = await (await post("/api/cards", JSON.stringify({ title: "t", description: "- [x] a\n- [ ] b", howToVerify: "- [ ] c", verifyNotes: "- [ ] z" }))).json();
    expect(c).toMatchObject({ tasksDone: 1, tasksTotal: 3 });
    const list = await (await fetch(`${base}/api/cards`)).json();
    expect(list.find((x: { id: number }) => x.id === c.id)).toMatchObject({ tasksDone: 1, tasksTotal: 3 });
    const put = await fetch(`${base}/api/cards/${c.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: "- [x] a\n- [x] b" }) });
    const u = await put.json();
    expect(u).toMatchObject({ tasksDone: 2, tasksTotal: 3 });
    expect(u.history).toHaveLength(1);
  });
});

describe("agent fields", () => {
  test("list exposes agent, agentAt, agentLive; live info constant; PUT cannot set them", async () => {
    const dir = boardDir(root);
    const a = createCard(dir, { title: "live one" }, { by: "ui" });
    const b = createCard(dir, { title: "stale one" }, { by: "ui" });
    startAgent(dir, a.id, "sess1234", { by: "cli" });
    startAgent(dir, b.id, "old12345", { by: "cli", now: new Date(Date.now() - 6 * 60 * 1000) });
    const list = await (await fetch(`${base}/api/cards`)).json();
    expect(list.find((c: any) => c.id === a.id)).toMatchObject({ agent: "sess1234", agentLive: true });
    expect(list.find((c: any) => c.id === b.id)).toMatchObject({ agent: "old12345", agentLive: false });
    expect(list.find((c: any) => c.id === b.id).agentAt).toMatch(/Z$/);
    expect((await (await fetch(`${base}/api/info`)).json()).agentLiveMs).toBe(300000);
    const put = await fetch(`${base}/api/cards/${a.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "x", blocked: true }) });
    expect((await put.json()).agent).toBe("sess1234");
  });
});

test("serves prompt.js", async () => {
  const r = await fetch(`${base}/prompt.js`);
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("buildPrompt");
});
