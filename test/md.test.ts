import { describe, expect, test } from "bun:test";
const { renderMarkdown: md } = require("../public/md.js");

describe("renderMarkdown", () => {
  test("escapes raw HTML (model output may echo documents)", () => {
    expect(md(`<script>alert(1)</script> <img src=x onerror=y>`)).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=y&gt;</p>",
    );
  });

  test("only http(s) links become anchors; quotes cannot break out", () => {
    expect(md("[a](javascript:alert(1))")).toBe("<p>[a](javascript:alert(1))</p>");
    expect(md('[a](https://x.io/"onclick=y)')).toContain('href="https://x.io/&quot;onclick=y"');
  });

  test("inline formatting; code span content is literal", () => {
    expect(md("**b** *i* `**x** <y>`")).toBe("<p><strong>b</strong> <em>i</em> <code>**x** &lt;y&gt;</code></p>");
  });

  test("arithmetic and snake_case are not mangled", () => {
    expect(md("2 * 3 * 4 and snake_case_name")).toBe("<p>2 * 3 * 4 and snake_case_name</p>");
  });

  test("headings, hr, paragraphs keep line breaks", () => {
    expect(md("## T\n\na\nb\n\n---")).toBe("<h2>T</h2>\n<p>a<br>b</p>\n<hr>");
  });

  test("nested unordered list", () => {
    expect(md("- a\n- b\n  - c\n- d")).toBe("<ul><li>a</li><li>b<ul><li>c</li></ul></li><li>d</li></ul>");
  });

  test("ordered list continues across blank lines, keeps start", () => {
    expect(md("3. x\n\n4. y")).toBe('<ol start="3"><li>x</li><li>y</li></ol>');
  });

  test("table", () => {
    expect(md("| A | B |\n|---|:-:|\n| 1 | **2** |")).toBe(
      '<div class="table"><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table></div>',
    );
  });

  test("code fence escapes; unclosed fence (mid-stream) still renders", () => {
    expect(md("```\n<b>&\n```")).toBe("<pre><code>&lt;b&gt;&amp;</code></pre>");
    expect(md("```js\nlet a")).toBe("<pre><code>let a</code></pre>");
  });

  test("blockquote renders inner markdown", () => {
    expect(md("> **q**\n> r")).toBe("<blockquote><p><strong>q</strong><br>r</p></blockquote>");
  });
});
