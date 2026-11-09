import { describe, expect, test } from "bun:test";
import { renderMarkdown as md, toggleTask } from "./public/markdown.js";

// Inert means: only allowed elements, only allowed attribute names, and URL attributes limited to safe targets.
const allowedTags = new Set(["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "code", "pre", "ul", "ol", "li", "blockquote", "hr", "a", "img", "input", "span", "div"]);
const allowedAttrs = ["href", "src", "alt", "target", "rel", "class", "type", "data-task", "aria-label"];
function assertInert(html: string) {
  for (const m of html.matchAll(/<\/?([a-zA-Z0-9]+)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*>/g)) {
    expect(allowedTags.has(m[1].toLowerCase())).toBe(true);
    for (const a of m[2].matchAll(/\s+([a-zA-Z-]+)(?:="([^"]*)")?/g)) {
      if (a[1] === "checked" || a[1] === "disabled") continue;
      expect(allowedAttrs).toContain(a[1]);
      if (a[1] === "href") expect(a[2]).toMatch(/^(https?:\/\/|mailto:|\/images\/)/);
      if (a[1] === "src") expect(a[2]).toMatch(/^\/images\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
    }
  }
  // every "<" in the output must start a tag matched above, never stray markup
  const stripped = html.replace(/<\/?[a-zA-Z0-9]+(?:\s+[a-zA-Z-]+(?:="[^"]*")?)*\s*>/g, "");
  expect(stripped).not.toContain("<");
}
const maxNesting = (html: string) => {
  let d = 0, max = 0;
  for (const m of html.matchAll(/<(\/?)(ul|ol|blockquote|em|strong)>/g)) { d += m[1] ? -1 : 1; max = Math.max(max, d); }
  return max;
};

describe("blocks", () => {
  test("paragraphs and line breaks", () => {
    expect(md("one\ntwo\n\nthree")).toBe('<div class="md"><p>one<br>two</p><p>three</p></div>');
  });
  test("headings 1 to 6, 7 hashes is text", () => {
    expect(md("# A\n###### F")).toContain("<h1>A</h1><h6>F</h6>");
    expect(md("####### x")).toContain("<p>####### x</p>");
    expect(md("#nospace")).toContain("<p>#nospace</p>");
  });
  test("fenced code is escaped and not parsed", () => {
    const out = md("```js\n<b>x</b> **no**\n```\nafter");
    expect(out).toContain("<pre><code>&lt;b&gt;x&lt;/b&gt; **no**</code></pre>");
    expect(out).toContain("<p>after</p>");
  });
  test("unclosed fence runs to the end", () => {
    expect(md("```\na\nb")).toContain("<pre><code>a\nb</code></pre>");
  });
  test("lists, ordered and nested", () => {
    expect(md("- a\n- b")).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(md("1. a\n2) b")).toContain("<ol><li>a</li><li>b</li></ol>");
    expect(md("- a\n  - b\n- c")).toContain("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
  });
  test("switching between bullets and numbers starts a new list", () => {
    expect(md("- a\n1. b\n- c")).toContain("<ul><li>a</li></ul><ol><li>b</li></ol><ul><li>c</li></ul>");
  });
  test("dedent below the first item does not loop forever", () => {
    expect(md("    - a\n- b\n  - c")).toContain("<li>a</li>");
  });
  test("blockquote and hr", () => {
    expect(md("> quoted\n> more")).toContain("<blockquote><p>quoted<br>more</p></blockquote>");
    expect(md("---")).toContain("<hr>");
    expect(md("* * *")).toContain("<hr>");
  });
  test("empty and non-string input", () => {
    expect(md("")).toBe('<div class="md"></div>');
    expect(md(undefined as never)).toBe('<div class="md"></div>');
  });
});

describe("inline", () => {
  test("bold, italic, code", () => {
    expect(md("**b** *i* _j_ `c`")).toContain("<strong>b</strong> <em>i</em> <em>j</em> <code>c</code>");
  });
  test("snake_case and 2*3*4 style text are not italic by accident", () => {
    expect(md("snake_case_name")).toContain("snake_case_name");
    expect(md("a * b")).toContain("a * b");
  });
  test("backslash escapes", () => {
    expect(md("\\*not italic\\*")).toContain("*not italic*");
  });
  test("code spans keep markup literal", () => {
    expect(md("`<i>*x*</i>`")).toContain("<code>&lt;i&gt;*x*&lt;/i&gt;</code>");
  });
  test("links: only http, https, mailto", () => {
    expect(md("[a](https://x.test/p?q=1)")).toContain('<a href="https://x.test/p?q=1" target="_blank" rel="noopener noreferrer">a</a>');
    expect(md("[m](mailto:a@b.c)")).toContain('href="mailto:a@b.c"');
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "//evil.test", "/relative", "vbscript:x", "file:///etc/passwd", "java\tscript:x", " javascript:x"]) {
      const out = md(`[click](${bad})`);
      expect(out).not.toContain("<a ");
      expect(out).toContain("click");
    }
  });
  test("link quotes cannot break out of href", () => {
    const out = md('[x](https://a.test/"onmouseover="alert(1))');
    assertInert(out);
    expect(out).not.toContain("<a ");
  });
  test("images: only images/<safe name> with image extension", () => {
    expect(md("![shot](images/abc-1.png)")).toContain('<a href="/images/abc-1.png" target="_blank" rel="noopener noreferrer"><img src="/images/abc-1.png" alt="shot"></a>');
    for (const bad of ["http://evil.test/x.png", "/images/x.png", "images/../x.png", "images/a/b.png", "images/x.svg", "data:image/png;base64,AAAA", "javascript:alert(1)", "images/x.png\" onerror=\"alert(1)", "images/.png", "images/%2e%2e%2fx.png"]) {
      expect(md(`![a](${bad})`)).not.toContain("<img");
    }
  });
  test("image alt is escaped", () => {
    const out = md('![" onerror="alert(1)](images/a.png)');
    assertInert(out);
    expect(out).toContain("&quot;");
  });
});

describe("tasks", () => {
  test("renders checkboxes with stable indexes, toggleTask edits the nth", () => {
    const t = "- [ ] one\n- [x] two\ntext\n- [ ] three";
    const out = md(t);
    expect(out).toContain('<input type="checkbox" data-task="0" aria-label="Task">');
    expect(out).toContain('<input type="checkbox" data-task="1" checked aria-label="Task">');
    expect(out).toContain('data-task="2"');
    expect(toggleTask(t, 0, true)).toBe("- [x] one\n- [x] two\ntext\n- [ ] three");
    expect(toggleTask(t, 1, false)).toBe("- [ ] one\n- [ ] two\ntext\n- [ ] three");
    expect(toggleTask(t, 2, true).endsWith("- [x] three")).toBe(true);
  });
  test("tasks inside code fences and quotes are not counted", () => {
    const t = "```\n- [ ] fake\n```\n> - [ ] quoted\n- [ ] real";
    const out = md(t);
    expect(out).toContain('data-task="0"');
    expect(out).not.toContain('data-task="1"');
    expect(toggleTask(t, 0, true)).toBe("```\n- [ ] fake\n```\n> - [ ] quoted\n- [x] real");
  });
  test("toggleTask out of range is a no-op", () => {
    expect(toggleTask("- [ ] a", 5, true)).toBe("- [ ] a");
  });
  test("task text is rendered inline", () => {
    expect(md("- [ ] run `ci`")).toContain("<code>ci</code>");
  });
});

describe("security", () => {
  const payloads = [
    "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "<svg/onload=alert(1)>", "<a href=\"javascript:alert(1)\">x</a>",
    "**<script>alert(1)</script>**", "[<img src=x onerror=alert(1)>](https://a.test)", "![x](images/a.png)<script>", "`</code><script>alert(1)</script>`",
    "```\n</code></pre><script>alert(1)</script>\n```", "# <script>alert(1)</script>", "> <iframe src=javascript:alert(1)>", "- <b onmouseover=alert(1)>x</b>",
    "[a](https://x.test) <style>*{display:none}</style>", "&lt;script&gt;alert(1)&lt;/script&gt;", "<!-- -->", "<![CDATA[ x ]]>", "\\<script>alert(1)\\</script>",
    "**unclosed <script>", "[unclosed link <script>(", "![unclosed(images/a.png", "_<script>_", "- [ ] <script>alert(1)</script>",
  ];
  test.each(payloads)("inert: %s", (p) => {
    const out = md(p);
    assertInert(out);
    expect(out).not.toContain("<script");
    expect(out).not.toMatch(/<(iframe|style|svg|b|i)[\s>/]/i);
  });
  test("raw html is shown as text", () => {
    expect(md("<b>hi</b>")).toContain("&lt;b&gt;hi&lt;/b&gt;");
  });
  test("input is capped and marked", () => {
    const out = md("a".repeat(200_000));
    expect(out.length).toBeLessThan(60_000);
    expect(out).toContain("truncated");
  });
  test("pathological inputs finish fast and stay inert", () => {
    const cases = [
      "[".repeat(50_000), "*".repeat(50_000), "`".repeat(50_000), "_".repeat(50_000), "![".repeat(25_000), "**a ".repeat(12_500),
      "[a](".repeat(12_000), ">".repeat(50_000), "> ".repeat(25_000) + "x", "- ".repeat(25_000), "\n".repeat(50_000), "#".repeat(50_000),
      Array.from({ length: 6000 }, (_, i) => " ".repeat(i % 40) + "- x").join("\n"), "* ".repeat(25_000), "1. ".repeat(16_000),
      "*a ".repeat(16_000), "_a ".repeat(16_000), "(".repeat(50_000), "[a](b ".repeat(8_000), "\\".repeat(50_000),
    ];
    for (const c of cases) {
      const t = performance.now();
      const out = md(c);
      expect(performance.now() - t).toBeLessThan(1500);
      assertInert(out);
    }
  });
  test("deep nesting is bounded", () => {
    const deepList = Array.from({ length: 200 }, (_, i) => " ".repeat(i * 2) + "- x").join("\n");
    const deepQuote = "> ".repeat(300) + "x";
    const deepEm = "*_".repeat(500) + "x" + "_*".repeat(500);
    for (const c of [deepList, deepQuote, deepEm]) {
      const out = md(c);
      assertInert(out);
      expect(maxNesting(out)).toBeLessThanOrEqual(8);
    }
  });
});
