import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const repo = "bladecell/project-board";
export const checkEveryMs = 24 * 60 * 60 * 1000;
export type Cache = { checkedAt: number; latest: string };

const parse = (v: string) => /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(v.trim())?.slice(1).map(Number) ?? null;
export function newer(latest: string, current: string) {
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export const cacheFile = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "project-board", "update.json");

function readCache(file: string): Cache | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return Number.isFinite(j?.checkedAt) && typeof j?.latest === "string" && parse(j.latest) ? { checkedAt: j.checkedAt, latest: j.latest } : null;
  } catch { return null; }
}

// Latest published release tag (e.g. "v0.2.0"), or "" when there is none or GitHub is unreachable.
export async function fetchLatest(fetcher: typeof fetch = fetch): Promise<string> {
  try {
    const r = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "project-board" },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return "";
    const tag = (await r.json())?.tag_name;
    return typeof tag === "string" && parse(tag) ? tag : "";
  } catch { return ""; }
}

// Checks at most once a day, never throws. Returns the newer tag, or "".
export async function checkForUpdate(current: string, opts: { file?: string; now?: number; fetcher?: typeof fetch; force?: boolean } = {}): Promise<string> {
  if (process.env.BOARD_NO_UPDATE_CHECK === "1" && !opts.force) return "";
  const file = opts.file ?? cacheFile(), now = opts.now ?? Date.now();
  let c = readCache(file);
  if (opts.force || !c || now - c.checkedAt > checkEveryMs || c.checkedAt > now) {
    const latest = await fetchLatest(opts.fetcher);
    c = { checkedAt: now, latest: latest || c?.latest || "" };
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(c)); } catch {}
  }
  return c.latest && newer(c.latest, current) ? c.latest : "";
}

const git = (dir: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};

// Move the install checkout to a release tag. Refuses on a dirty tree or a non-git install.
export function installTag(dir: string, tag: string): string {
  if (!parse(tag)) throw new Error(`bad release tag "${tag}"`);
  if (!existsSync(join(dir, ".git"))) throw new Error(`${dir} is not a git checkout; reinstall with the install script`);
  if (git(dir, "status", "--porcelain").out) throw new Error(`${dir} has local changes; commit or discard them first`);
  const f = git(dir, "fetch", "--depth", "1", "origin", "tag", tag, "--no-tags");
  if (!f.ok) throw new Error(`could not fetch ${tag}: ${f.err.split("\n")[0]}`);
  const c = git(dir, "checkout", "-q", `refs/tags/${tag}`);
  if (!c.ok) throw new Error(`could not switch to ${tag}: ${c.err.split("\n")[0]}`);
  return tag;
}
