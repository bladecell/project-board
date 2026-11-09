import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardDir, initBoard } from "./lib";
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
});
