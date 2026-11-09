import { execFile } from "node:child_process";

export type Commit = { hash: string; short: string; at: string; author: string; subject: string };

const maxCommits = 2000;
const maxSubject = 200;
const cache = new Map<string, { at: number; p: Promise<Commit[]> }>();

function run(cwd: string, bin: string): Promise<Commit[]> {
  return new Promise((resolve) => {
    execFile(
      bin, ["log", "-n", String(maxCommits), "--format=%H%x1f%aI%x1f%an%x1f%s"],
      { cwd, timeout: 3000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => {
        // an oversized log still yields the newest commits that were read
        if (err && !String((err as { code?: unknown }).code).includes("MAXBUFFER")) return resolve([]);
        resolve(String(stdout).split("\n").flatMap((l) => {
          const [hash, at, author, ...rest] = l.split("\x1f");
          const subject = rest.join("\x1f");
          return /^[0-9a-f]{40}$/.test(hash ?? "") && subject ? [{ hash, short: hash.slice(0, 7), at, author, subject: subject.slice(0, maxSubject) }] : [];
        }));
      },
    );
  });
}

// Never rejects: no git, no repo, timeouts and errors all give [].
export function getCommits(cwd: string, opts: { ttl?: number; bin?: string } = {}): Promise<Commit[]> {
  const ttl = opts.ttl ?? 10_000;
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < ttl) return hit.p;
  const p = run(cwd, opts.bin ?? "git");
  if (ttl > 0) cache.set(cwd, { at: Date.now(), p });
  return p;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whole token: not glued to letters/digits, and "P2.3" must not match "P2.30", "P2.3b" or "P2.3.1".
const token = (t: string) => new RegExp(`(?<![A-Za-z0-9])${esc(t)}(?![A-Za-z0-9]|\\.[A-Za-z0-9])`);

// Newest-first commits per card id. Matching is on the subject only.
export function linkCommits(commits: Commit[], cards: { id: number; taskId: string }[]): Map<number, Commit[]> {
  const out = new Map<number, Commit[]>();
  const probes = cards.map((c) => [c.id, [c.taskId, `#${c.id}`].filter(Boolean).map((t) => ({ t, re: token(t) }))] as const);
  for (const commit of commits) {
    for (const [id, toks] of probes) {
      if (toks.some(({ t, re }) => commit.subject.includes(t) && re.test(commit.subject))) {
        const list = out.get(id);
        list ? list.push(commit) : out.set(id, [commit]);
      }
    }
  }
  return out;
}
