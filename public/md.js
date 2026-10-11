// md.js — tiny Markdown -> HTML renderer for assistant answers (no dependency).
// Safe by construction: all text is HTML-escaped first; only our own tags are emitted,
// and only http(s) links become <a>. Model output can echo document content, so this matters.
// Covers what LLM answers use: headings, paragraphs, (nested) lists, code, quotes, tables, hr,
// **bold**, *italic*, `code`, [links](https://...). Anything else renders as plain text.

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s) {
  // Pull code spans out first so their content is not formatted.
  const codes = [];
  s = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*(\*{3,}|-{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (l) => l.match(/^\s*/)[0].length;
const isTable = (lines, i) => lines[i].includes("|") && TABLE_SEP.test(lines[i + 1] ?? "");
const startsBlock = (lines, i) =>
  FENCE.test(lines[i]) || HEADING.test(lines[i]) || HR.test(lines[i]) || QUOTE.test(lines[i]) || LIST.test(lines[i]) || isTable(lines, i);
const cells = (l) =>
  l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(c.trim()));

// List item: first line inline; continuation lines (dedented) rendered recursively (nested lists).
function renderItem({ first, rest }) {
  const body = rest.filter((l) => l.trim());
  if (!body.length) return `<li>${inline(first)}</li>`;
  const cut = Math.min(...body.map(indentOf));
  return `<li>${inline(first)}${renderMarkdown(rest.map((l) => l.slice(cut)).join("\n"))}</li>`;
}

function renderMarkdown(src) {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let m;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
    } else if (FENCE.test(l)) {
      const body = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
      i++; // closing fence (may be missing mid-stream)
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
    } else if ((m = l.match(HEADING))) {
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      i++;
    } else if (HR.test(l)) {
      out.push("<hr>");
      i++;
    } else if (QUOTE.test(l)) {
      const body = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
    } else if (isTable(lines, i)) {
      const head = cells(l);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) rows.push(cells(lines[i]));
      const tr = (r, tag) => `<tr>${r.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
      out.push(`<div class="table"><table><thead>${tr(head, "th")}</thead><tbody>${rows.map((r) => tr(r, "td")).join("")}</tbody></table></div>`);
    } else if ((m = l.match(LIST))) {
      const base = m[1].length;
      const ordered = /\d/.test(m[2]);
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        const mm = cur.match(LIST);
        if (mm && mm[1].length <= base) {
          if (/\d/.test(mm[2]) !== ordered) break; // switching list type ends this list
          items.push({ first: mm[3], rest: [] });
        } else if (cur.trim() && indentOf(cur) > base) {
          items[items.length - 1].rest.push(cur);
        } else if (!cur.trim()) {
          // Blank line: the list continues only if the next line belongs to it.
          const next = lines[i + 1] ?? "";
          const nm = next.match(LIST);
          const continues = (nm && nm[1].length <= base && /\d/.test(nm[2]) === ordered) || (next.trim() && indentOf(next) > base);
          if (!continues) break;
          items[items.length - 1].rest.push("");
        } else break;
        i++;
      }
      const n = parseInt(m[2]);
      const start = ordered && n !== 1 ? ` start="${n}"` : "";
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}${start}>${items.map(renderItem).join("")}</${tag}>`);
    } else {
      // Paragraph: consecutive plain lines; keep the model's line breaks.
      const body = [inline(l.trim())];
      for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines, i); i++) body.push(inline(lines[i].trim()));
      out.push(`<p>${body.join("<br>")}</p>`);
    }
  }
  return out.join("\n");
}

// Browser: global function. Bun tests: CommonJS export.
if (typeof module !== "undefined") module.exports = { renderMarkdown };
