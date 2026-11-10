import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkForUpdate, checkEveryMs, installTag, newer } from "./update";

const scratch = process.env.TMPDIR ?? "/tmp";
let dir: string, file: string;
beforeEach(() => { dir = mkdtempSync(join(scratch, "upd-")); file = join(dir, "sub", "update.json"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const rel = (tag: unknown, ok = true) => (async () => new Response(JSON.stringify({ tag_name: tag }), { status: ok ? 200 : 404 })) as unknown as typeof fetch;

describe("newer", () => {
  test("compares numerically, ignores bad input", () => {
    expect(newer("v0.10.0", "0.9.5")).toBe(true);
    expect(newer("v1.0.0", "1.0.0")).toBe(false);
    expect(newer("v0.1.0", "0.2.0")).toBe(false);
    expect(newer("junk", "0.1.0")).toBe(false);
    expect(newer("v1.0.0-rc1", "0.1.0")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  test("reports a newer release and caches it", async () => {
    expect(await checkForUpdate("0.1.0", { file, now: 1000, fetcher: rel("v0.2.0") })).toBe("v0.2.0");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ checkedAt: 1000, latest: "v0.2.0" });
  });
  test("uses the cache inside 24h, refetches after", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response(JSON.stringify({ tag_name: "v0.3.0" })); }) as unknown as typeof fetch;
    await checkForUpdate("0.1.0", { file, now: 1000, fetcher: f });
    await checkForUpdate("0.1.0", { file, now: 1000 + checkEveryMs - 1, fetcher: f });
    expect(calls).toBe(1);
    await checkForUpdate("0.1.0", { file, now: 1000 + checkEveryMs + 1, fetcher: f });
    expect(calls).toBe(2);
  });
  test("network failure, bad payload or no release means no update and no throw", async () => {
    const boom = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await checkForUpdate("0.1.0", { file, now: 1, fetcher: boom })).toBe("");
    expect(await checkForUpdate("0.1.0", { file, now: 1, force: true, fetcher: rel("latest") })).toBe("");
    expect(await checkForUpdate("0.1.0", { file, now: 1, force: true, fetcher: rel(null, false) })).toBe("");
  });
  test("keeps the last known release when a refresh fails", async () => {
    await checkForUpdate("0.1.0", { file, now: 1, fetcher: rel("v0.2.0") });
    const boom = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await checkForUpdate("0.1.0", { file, now: 1 + checkEveryMs + 5, fetcher: boom })).toBe("v0.2.0");
  });
  test("a corrupt cache is ignored", async () => {
    await checkForUpdate("0.1.0", { file, now: 1, fetcher: rel("v0.2.0") });
    writeFileSync(file, "{nope");
    expect(await checkForUpdate("0.1.0", { file, now: 2, fetcher: rel("v0.4.0") })).toBe("v0.4.0");
  });
  test("BOARD_NO_UPDATE_CHECK=1 skips the network", async () => {
    process.env.BOARD_NO_UPDATE_CHECK = "1";
    try { expect(await checkForUpdate("0.1.0", { file, fetcher: rel("v9.0.0") })).toBe(""); expect(existsSync(file)).toBe(false); }
    finally { delete process.env.BOARD_NO_UPDATE_CHECK; }
  });
});

describe("installTag", () => {
  test("rejects odd tags and non-git directories", () => {
    expect(() => installTag(dir, "--upload-pack=x")).toThrow("bad release tag");
    expect(() => installTag(dir, "v1.0.0")).toThrow("not a git checkout");
  });
});
