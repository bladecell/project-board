import { mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import { getCommits, linkCommits } from "./commits";
import { taskCounts, isAgentLive, AGENT_LIVE_MS, atomicWrite, createCard, deleteCard, loadCards, moveCard, sortCards, updateCard, columns, type Card } from "./lib";

const ui = { by: "ui" } as const;
const maxJson = 1_000_000;
const maxImage = 10 * 1024 * 1024;
const imageTypes: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const extTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const security = { "x-content-type-options": "nosniff", "cache-control": "no-cache" };

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: security });
const publicCard = ({ file, ...c }: Card) => ({ ...c, ...taskCounts(c), agentLive: isAgentLive(c) });
const maxCardCommits = 50;

async function readBody(req: Request, max: number) {
  if (Number(req.headers.get("content-length") ?? 0) > max) throw new HttpError(413, "body too large");
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > max) throw new HttpError(413, "body too large");
  return buf;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) throw new HttpError(415, "expected application/json");
  try {
    const v = JSON.parse(new TextDecoder().decode(await readBody(req, maxJson)));
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw 0;
    return v;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "invalid JSON");
  }
}

export function startServer(dir: string, port: number, name: string) {
  const cardsDir = join(dir, "cards");
  const imagesDir = join(dir, "images");
  mkdirSync(imagesDir, { recursive: true });
  const clients = new Set<ReadableStreamDefaultController<string>>();
  const enc = new TextEncoder();
  const send = (msg: string) => {
    for (const c of clients) {
      try { c.enqueue(msg); } catch { clients.delete(c); }
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(cardsDir, (_e, name) => {
    if (name && !name.endsWith(".md")) return;
    clearTimeout(timer);
    timer = setTimeout(() => send("data: change\n\n"), 80);
  });
  const heartbeat = setInterval(() => send(": ping\n\n"), 15_000);

  const cardId = (s: string) => {
    const id = Number(s);
    if (!Number.isSafeInteger(id)) throw new HttpError(404, "not found");
    return id;
  };

  async function route(req: Request, url: URL): Promise<Response> {
    const { pathname: p } = url;
    const m = req.method;

    if (m === "GET" && p === "/") return new Response(Bun.file(join(import.meta.dir, "public/index.html")), { headers: { ...security, "content-type": "text/html; charset=utf-8" } });
    if (m === "GET" && p === "/markdown.js") return new Response(Bun.file(join(import.meta.dir, "public/markdown.js")), { headers: { ...security, "content-type": "text/javascript; charset=utf-8" } });
    const bg = m === "GET" && p.match(/^\/contour-(light|dark)\.svg$/);
    if (bg) return new Response(Bun.file(join(import.meta.dir, `public/contour-${bg[1]}.svg`)), { headers: { ...security, "content-type": "image/svg+xml", "cache-control": "max-age=86400" } });
    if (m === "GET" && p === "/api/info") return json({ name, columns, agentLiveMs: AGENT_LIVE_MS });
    if (m === "GET" && p === "/api/cards") {
      const cards = sortCards(loadCards(dir));
      const links = linkCommits(await getCommits(dir), cards);
      return json(cards.map((c) => ({ ...publicCard(c), commitCount: links.get(c.id)?.length ?? 0 })));
    }
    if (m === "GET" && p === "/api/events") {
      server.timeout(req, 0);
      let ctl: ReadableStreamDefaultController<string>;
      const stream = new ReadableStream<string>({
        start(c) { ctl = c; clients.add(c); c.enqueue(": open\n\n"); },
        cancel() { clients.delete(ctl); },
      });
      return new Response(stream.pipeThrough(new TextEncoderStream()), { headers: { ...security, "content-type": "text/event-stream", connection: "keep-alive" } });
    }

    if (m === "POST" && p === "/api/cards") return json(publicCard(createCard(dir, await readJson(req), ui)), 201);

    const cm = /^\/api\/cards\/(\d{1,9})(\/move)?$/.exec(p);
    if (cm) {
      const id = cardId(cm[1]);
      if (m === "GET" && !cm[2]) {
        const cards = loadCards(dir);
        const card = cards.find((c) => c.id === id);
        if (!card) throw new HttpError(404, "no card " + id);
        const all = linkCommits(await getCommits(dir), [card]).get(id) ?? [];
        return json({ ...publicCard(card), commitCount: all.length, commits: all.slice(0, maxCardCommits) });
      }
      if (m === "PUT" && !cm[2]) return json(publicCard(updateCard(dir, id, await readJson(req), ui)));
      if (m === "DELETE" && !cm[2]) { deleteCard(dir, id); return json({ ok: true }); }
      if (m === "POST" && cm[2]) {
        const b = await readJson(req);
        if (!columns.includes(b.column as never)) throw new HttpError(400, "invalid column");
        const before = b.before === null || b.before === undefined ? null : Number(b.before);
        if (before !== null && !Number.isSafeInteger(before)) throw new HttpError(400, "invalid before");
        return json(publicCard(moveCard(dir, id, b.column as never, before, undefined, ui)));
      }
    }

    if (m === "POST" && p === "/api/images") {
      const ext = imageTypes[(req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()];
      if (!ext) throw new HttpError(415, "only png, jpeg, gif and webp images");
      const body = await readBody(req, maxImage);
      if (!body.byteLength) throw new HttpError(400, "empty body");
      const name = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
      atomicWrite(join(imagesDir, name), body);
      return json({ url: `images/${name}` }, 201);
    }

    const im = /^\/images\/([A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(png|jpg|jpeg|gif|webp))$/.exec(p);
    if (m === "GET" && im && !im[1].includes("..")) {
      const file = Bun.file(join(imagesDir, im[1]));
      if (!(await file.exists())) throw new HttpError(404, "not found");
      return new Response(file, { headers: { ...security, "content-type": extTypes[im[2]] } });
    }
    throw new HttpError(404, "not found");
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: maxImage + 1024,
    async fetch(req) {
      try {
        const url = new URL(req.url);
        const host = req.headers.get("host");
        if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) throw new HttpError(403, "bad host");
        if (req.method !== "GET" && req.method !== "HEAD") {
          const origin = req.headers.get("origin");
          if (origin && origin !== `http://${host}`) throw new HttpError(403, "bad origin");
        }
        return await route(req, url);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        if (e instanceof Error && /^(no card|title required|invalid|\w+ (must be|too long))/.test(e.message)) {
          return json({ error: e.message }, /^no card/.test(e.message) ? 404 : 400);
        }
        console.error(e);
        return json({ error: "internal error" }, 500);
      }
    },
  });

  return {
    port: server.port,
    close() {
      clearInterval(heartbeat);
      clearTimeout(timer);
      watcher.close();
      for (const c of clients) { try { c.close(); } catch {} }
      void server.stop(true);
    },
  };
}
