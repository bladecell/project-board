// Small markdown renderer for card text. Card text is untrusted (agents, pasted web content):
// every piece of text is escaped, no raw HTML passes through, and only http(s)/mailto links and
// local images/<name> images become elements. No backtracking-prone regexes on user text.
const MAX_CHARS = 50_000;
const MAX_DEPTH = 6;
const escMap = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => s.replace(/[&<>"']/g, (c) => escMap[c]);

const imgOk = (u) => /^images\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(?:png|jpe?g|gif|webp)$/.test(u) && !u.includes("..");
const linkOk = (u) => u.length <= 2000 && /^(?:https?:\/\/|mailto:)[^\s<>"'`\\\u0000-\u001f]+$/i.test(u);

const isSpace = (c) => c === undefined || c === " " || c === "\t" || c === "\n";
const isWord = (c) => c !== undefined && /[A-Za-z0-9]/.test(c);
const escapable = "\\`*_{}[]()#+-.!>|~<&\"'";

function inline(s, depth, noLink) {
  const out = [];
  let buf = "";
  let i = 0;
  const failFrom = {};
  // once a needle is missing after position p it is missing after every later position
  const find = (needle, from) => {
    if (failFrom[needle] !== undefined && from >= failFrom[needle]) return -1;
    const r = s.indexOf(needle, from);
    if (r < 0) failFrom[needle] = from;
    return r;
  };
  const flush = () => { if (buf) { out.push(esc(buf)); buf = ""; } };
  const canNest = depth < MAX_DEPTH;

  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && escapable.includes(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (ch === "\n") { flush(); out.push("<br>"); i++; continue; }
    if (ch === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const end = find(fence, i + n);
      if (end > i + n) { flush(); out.push(`<code>${esc(s.slice(i + n, end))}</code>`); i = end + n; }
      else { buf += fence; i += n; }
      continue;
    }
    if ((ch === "!" && s[i + 1] === "[") || (ch === "[" && !noLink)) {
      const img = ch === "!";
      const open = img ? i + 2 : i + 1;
      const close = find("]", open);
      if (close >= 0 && s[close + 1] === "(") {
        const end = find(")", close + 2);
        if (end >= 0) {
          const label = s.slice(open, close);
          const url = s.slice(close + 2, end).trim();
          if (img && imgOk(url)) {
            flush();
            out.push(`<a href="/${url}" target="_blank" rel="noopener noreferrer"><img src="/${url}" alt="${esc(label)}"></a>`);
          } else if (!img && linkOk(url)) {
            flush();
            out.push(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${canNest ? inline(label, depth + 1, true) : esc(label)}</a>`);
          } else buf += s.slice(i, end + 1);
          i = end + 1;
          continue;
        }
      }
      buf += ch; i++;
      continue;
    }
    if ((ch === "*" || ch === "_") && canNest && !(ch === "_" && isWord(s[i - 1]))) {
      if (s[i + 1] === ch) {
        const close = find(ch + ch, i + 2);
        if (close > i + 2 && !isSpace(s[i + 2]) && !isSpace(s[close - 1]) && (ch === "*" || !isWord(s[close + 2]))) {
          flush();
          out.push(`<strong>${inline(s.slice(i + 2, close), depth + 1, noLink)}</strong>`);
          i = close + 2;
          continue;
        }
      } else if (!isSpace(s[i + 1])) {
        const bad = (c) => isSpace(s[c - 1]) || s[c + 1] === ch || (ch === "_" && isWord(s[c + 1]));
        let close = find(ch, i + 1);
        for (let t = 0; close >= 0 && bad(close) && t < 3; t++) close = find(ch, close + 1);
        if (close > i + 1 && !bad(close)) {
          flush();
          out.push(`<em>${inline(s.slice(i + 1, close), depth + 1, noLink)}</em>`);
          i = close + 1;
          continue;
        }
      }
    }
    buf += ch; i++;
  }
  flush();
  return out.join("");
}

const fenceOpen = /^ {0,3}```/;
const fenceClose = /^ {0,3}```\s*$/;
const isQuote = (l) => /^ {0,3}>/.test(l);
const isBlank = (l) => l.trim() === "";
function isHr(l) {
  const t = l.replace(/[ \t]/g, "");
  return t.length >= 3 && (/^-+$/.test(t) || /^\*+$/.test(t) || /^_+$/.test(t));
}
function heading(l) {
  const m = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(l);
  if (!m) return null;
  let s = m[2].trimEnd();
  let e = s.length;
  while (e > 0 && s[e - 1] === "#") e--;
  if (e < s.length && (e === 0 || s[e - 1] === " ")) s = s.slice(0, e).trimEnd();
  return { level: m[1].length, text: s };
}
function listLine(l) {
  let indent = 0, i = 0;
  while (i < l.length && i < 64 && (l[i] === " " || l[i] === "\t")) { indent += l[i] === "\t" ? 4 : 1; i++; }
  const m = /^([-*+]|\d{1,9}[.)])[ \t]+(.*)$/.exec(l.slice(i));
  return m ? { indent, ordered: /\d/.test(m[1][0]), body: m[2], at: i + m[0].length - m[2].length } : null;
}
const taskBody = (body) => {
  const m = /^\[( |x|X)\](?:[ \t]+(.*))?$/.exec(body);
  return m ? { checked: m[1] !== " ", text: m[2] ?? "" } : null;
};
const startsBlock = (l, depth) =>
  fenceOpen.test(l) || heading(l) !== null || isHr(l) || (depth < MAX_DEPTH && isQuote(l)) || (listLine(l) !== null);

function renderList(items, pos, depth, ctr) {
  const base = items[pos.i].indent;
  const ordered = items[pos.i].ordered;
  const tag = ordered ? "ol" : "ul";
  let html = `<${tag}>`;
  while (pos.i < items.length && items[pos.i].indent >= base && (items[pos.i].indent > base || items[pos.i].ordered === ordered)) {
    const it = items[pos.i++];
    const task = taskBody(it.body);
    let inner;
    if (task) {
      const attrs = ctr ? `data-task="${ctr.n++}"` : "disabled";
      inner = `<input type="checkbox" ${attrs}${task.checked ? " checked" : ""} aria-label="Task"><span>${inline(task.text + it.more, 0, false)}</span>`;
    } else inner = inline(it.body + it.more, 0, false);
    html += `<li${task ? ' class="task"' : ""}>${inner}`;
    while (pos.i < items.length && items[pos.i].indent > base && depth < MAX_DEPTH) html += renderList(items, pos, depth + 1, ctr);
    html += "</li>";
  }
  return `${html}</${tag}>`;
}

function blocks(lines, depth, ctr) {
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (isBlank(l)) { i++; continue; }
    if (fenceOpen.test(l)) {
      const code = [];
      i++;
      while (i < lines.length && !fenceClose.test(lines[i])) code.push(lines[i++]);
      i++;
      html += `<pre><code>${esc(code.join("\n"))}</code></pre>`;
      continue;
    }
    const h = heading(l);
    if (h) { html += `<h${h.level}>${inline(h.text, 0, false)}</h${h.level}>`; i++; continue; }
    if (isHr(l)) { html += "<hr>"; i++; continue; }
    if (depth < MAX_DEPTH && isQuote(l)) {
      const q = [];
      while (i < lines.length && isQuote(lines[i])) q.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      html += `<blockquote>${blocks(q, depth + 1, null)}</blockquote>`;
      continue;
    }
    if (listLine(l)) {
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        const ll = isHr(cur) ? null : listLine(cur);
        if (ll) { items.push({ ...ll, more: "" }); i++; continue; }
        if (isBlank(cur)) {
          let j = i;
          while (j < lines.length && isBlank(lines[j])) j++;
          if (j < lines.length && !isHr(lines[j]) && listLine(lines[j])) { i = j; continue; }
          break;
        }
        if (/^[ \t]/.test(cur) && !startsBlock(cur, depth)) { items.at(-1).more += `\n${cur.trim()}`; i++; continue; }
        break;
      }
      const pos = { i: 0 };
      while (pos.i < items.length) html += renderList(items, pos, 0, ctr);
      continue;
    }
    const para = [l];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i], depth)) para.push(lines[i++]);
    html += `<p>${inline(para.join("\n"), 0, false)}</p>`;
  }
  return html;
}

export function renderMarkdown(src) {
  const full = typeof src === "string" ? src : "";
  const text = full.slice(0, MAX_CHARS).replace(/\r\n?/g, "\n");
  const note = full.length > MAX_CHARS ? `<p>(truncated at ${MAX_CHARS} characters)</p>` : "";
  return `<div class="md">${blocks(text.split("\n"), 0, { n: 0 })}${note}</div>`;
}

// Flip the nth task checkbox in the source text. Same scan as the renderer: skips code fences
// and quotes, so data-task indexes always line up.
export function toggleTask(src, index, on) {
  const lines = String(src ?? "").split("\n");
  let n = 0, inFence = false;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (inFence) { if (fenceClose.test(l)) inFence = false; continue; }
    if (fenceOpen.test(l)) { inFence = true; continue; }
    if (isQuote(l) || isHr(l)) continue;
    const ll = listLine(l);
    if (!ll || !taskBody(ll.body)) continue;
    if (n++ === index) {
      lines[k] = `${l.slice(0, ll.at + 1)}${on ? "x" : " "}${l.slice(ll.at + 2)}`;
      break;
    }
  }
  return lines.join("\n");
}
