// GitHub-flavoured markdown rendering.
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import hljs from './hljs.js';
import { headerTitle, parseFrontMatter, looksLikeFrontMatter } from './front-matter.js';

const ALERTS = new Set(['note', 'tip', 'important', 'warning', 'caution']);

/** GitHub alert blockquotes: `> [!NOTE]` and friends. */
function alertPlugin(md) {
  md.core.ruler.after('block', 'gh_alerts', (state) => {
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'blockquote_open') continue;
      const inline = toks[i + 2];
      if (!inline || inline.type !== 'inline') continue;
      const m = /^\[!(\w+)\]\s*\n?/.exec(inline.content);
      if (!m || !ALERTS.has(m[1].toLowerCase())) continue;

      const kind = m[1].toLowerCase();
      inline.content = inline.content.slice(m[0].length);
      if (inline.children?.length) {
        inline.children[0].content = inline.children[0].content.replace(/^\[!\w+\]\s*/, '');
        if (inline.children[1]?.type === 'softbreak') inline.children.splice(1, 1);
      }
      toks[i].attrJoin('class', `markdown-alert markdown-alert-${kind}`);

      const title = new state.Token('html_block', '', 0);
      title.content =
        `<p class="markdown-alert-title">${kind[0].toUpperCase()}${kind.slice(1)}</p>\n`;
      toks.splice(i + 1, 0, title);
    }
  });
}

/** One line of the source, without its indent or its newline. */
function lineText(state, line) {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]).trimEnd();
}

/**
 * The `---` header block at the top of a file: fields about the document.
 *
 * A block rule rather than a preprocessing step, so the header is a token like
 * any other and everything downstream gets it for free — it is one block to the
 * diff, it takes a `data-line` from `sourceLines`, and it contributes no heading
 * to the contents list. See `src/front-matter.js` for what is read out of it.
 *
 * Only at line 0, which is also true inside the diff: a block is re-parsed on
 * its own there and the header block's own first line is line 0, while a `---`
 * rule from the middle of a document arrives alone with no closing fence and
 * falls straight through to `hr`.
 */
function frontMatterBlock(md) {
  md.block.ruler.before(
    'hr',
    'front_matter',
    (state, startLine, endLine, silent) => {
      if (startLine !== 0 || state.sCount[startLine] !== 0) return false;
      if (lineText(state, startLine) !== '---') return false;

      let close = -1;
      for (let i = startLine + 1; i < endLine; i++) {
        if (state.sCount[i] !== 0) continue;
        const t = lineText(state, i);
        if (t === '---' || t === '...') {
          close = i;
          break;
        }
      }
      if (close < 0) return false;

      // Parsed before being accepted, because whether this is a header at all
      // is a question about what is inside it: `---`, prose, `---` is a setext
      // heading and has to stay one.
      const body = state.getLines(startLine + 1, close, 0, false);
      const rows = parseFrontMatter(body);
      if (!looksLikeFrontMatter(rows)) return false;
      if (silent) return true;

      const token = state.push('front_matter', 'div', 0);
      token.markup = '---';
      token.content = body;
      token.meta = { rows };
      token.map = [startLine, close + 1];
      state.line = close + 1;
      return true;
    },
    // Not allowed to interrupt a paragraph or a list: it is only ever the very
    // first thing in a parse, and `alt` is what would let it cut in elsewhere.
    { alt: [] },
  );

  md.renderer.rules.front_matter = (tokens, idx) => {
    const token = tokens[idx];
    // Built by hand, so `data-line` has to be carried over by hand — the same
    // bookkeeping `diagramFences` does, and for the same reason: without it
    // this block is nowhere for the two views to line up on.
    const at = token.attrGet('data-line');
    return (
      `<div class="front-matter"${at == null ? '' : ` data-line="${at}"`}>` +
      `<dl>${fieldsHtml(token.meta.rows)}</dl></div>\n`
    );
  };
}

/** The rows of a header block, or of a mapping nested inside one. */
function fieldsHtml(rows) {
  let out = '';
  for (const { key, value } of rows) {
    // A line that is not a field continues the one above it, which is what an
    // extra `<dd>` means in a `<dl>` — and `looksLikeFrontMatter` has already
    // promised that the first row is not one of these.
    if (key == null) out += `<dd class="fm-raw">${escapeHtml(value.text)}</dd>`;
    else out += `<dt>${escapeHtml(key)}</dt><dd>${valueHtml(value)}</dd>`;
  }
  return out;
}

/**
 * One field's value. Escaped and never rendered as markdown: this is metadata
 * for a tool, and the reader's question about it is "what does the file
 * actually say", which italics eating a pair of underscores does not answer.
 */
function valueHtml(value) {
  if (value.kind === 'list') {
    return value.items.length
      ? `<ul>${value.items.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
      : '';
  }
  if (value.kind === 'map') return `<dl>${fieldsHtml(value.rows)}</dl>`;
  if (value.pre) return `<span class="fm-pre">${escapeHtml(value.text)}</span>`;
  return escapeHtml(value.text);
}

const PLANTUML_LANGS = new Set(['plantuml', 'puml', 'uml', 'pu', 'iuml']);

/**
 * Diagram fences: both kinds are left for the page to draw.
 *
 * Mermaid always worked this way — it is a browser renderer, so the fence
 * becomes a `pre.mermaid` and the page runs it. PlantUML used to be different:
 * it was rendered to inline SVG right here, because here was a node process
 * that could run the jar.
 *
 * It cannot be any more. This module now runs inside the webview, where there
 * is no process to spawn and nothing is synchronous, so PlantUML gets the same
 * treatment mermaid always had: a placeholder carrying the source, filled in
 * once whoever can run the jar has answered. `src/plantuml.js` still does the
 * rendering, now behind a request rather than a function call.
 *
 * The code is kept in the element rather than re-read from the markdown, so
 * filling a diagram needs nothing but the node — which matters for the diff,
 * where the same fence can appear twice (once as it was, once as it is).
 */
function diagramFences(md) {
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = (token.info || '').trim().split(/\s+/)[0].toLowerCase();
    const code = token.content;
    // Built by hand, so the attribute `sourceLines` set has to be carried over
    // by hand too — and a diagram is tall enough that losing it would leave a
    // screen of the document with nowhere to line the two views up on.
    const at = token.attrGet('data-line');
    const line = at == null ? '' : ` data-line="${at}"`;

    if (lang === 'mermaid') {
      return `<div class="diagram"${line}><pre class="mermaid">${escapeHtml(code)}</pre></div>\n`;
    }

    if (PLANTUML_LANGS.has(lang)) {
      return (
        `<div class="diagram diagram-plantuml"${line}>` +
        `<pre class="plantuml">${escapeHtml(code)}</pre>` +
        '</div>\n'
      );
    }

    return fence(tokens, idx, options, env, self);
  };
}

/**
 * Ids on headings, taken from a queue prepared for the whole document.
 *
 * They cannot be worked out here. The diff renders one block at a time, so a
 * rule that numbered its own repeats would start counting again at every block
 * and hand two `## Notes` the same id — and a heading that exists only in the
 * baseline would take an id belonging to one in the file. `outline` walks the
 * whole source once instead, and the render draws from that in document order.
 */
function headingAnchors(md) {
  const open = md.renderer.rules.heading_open;
  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const id = env?.slugs?.shift();
    if (id) tokens[idx].attrSet('id', id);
    return open ? open(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
}

/**
 * `data-line` on every top-level block: which line of the file it came from.
 *
 * The one coordinate the two views share. The raw view is the file's own lines
 * and says so already (see `renderRawDiff`); this is the rendered view saying
 * the same thing, so switching between them can land on the same sentence
 * rather than on the same number of pixels, which means nothing once the same
 * text is set at a different height.
 *
 * Only level 0, so the attribute lands on siblings and never on something
 * inside something else that also has one — the whole document reads as one
 * ascending list of lines, which is what makes finding a place in it a search
 * rather than a walk.
 *
 * The diff renders one block at a time, and a block parsed on its own believes
 * it starts at line 0, so where it really starts is passed in `env`. A block
 * rendered without one is not in the file at all — a deleted block is only in
 * the baseline — and goes unmarked, which is also what stops it being somewhere
 * to scroll to.
 */
function sourceLines(md) {
  md.core.ruler.push('source_lines', (state) => {
    const offset = state.env?.lineOffset;
    if (typeof offset !== 'number') return;
    for (const t of state.tokens) {
      if (t.level !== 0 || t.nesting === -1 || !t.map) continue;
      t.attrSet('data-line', String(t.map[0] + offset));
    }
  });
}

export function createMarkdown() {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
    breaks: false,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } catch {
          /* fall through to escaped plain text */
        }
      }
      return '';
    },
  });
  md.use(taskLists, { label: true });
  md.use(alertPlugin);
  frontMatterBlock(md);
  diagramFences(md);
  headingAnchors(md);
  sourceLines(md);
  return md;
}

/**
 * A heading's anchor, made the way GitHub makes one — so `[see below](#notes)`,
 * written against how the file reads on GitHub, lands in the same place here.
 */
export function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/\s+/g, '-');
}

/** A heading as plain words: what a contents row shows, and what its id is from. */
function headingText(inline) {
  if (!inline?.children) return (inline?.content ?? '').trim();
  let out = '';
  for (const t of inline.children) {
    // `image` carries its alt text, which is the only part of it that reads.
    if (t.type === 'text' || t.type === 'code_inline' || t.type === 'image') out += t.content;
    else if (t.type === 'softbreak' || t.type === 'hardbreak') out += ' ';
  }
  return out.trim();
}

/**
 * Every heading in the document, in order: the contents list, and the ids the
 * rendered headings are given.
 *
 * Every heading gets an entry, including an empty one. The ids are handed to the
 * renderer as a queue, so a heading passed over here would quietly take the
 * next heading's id; the list is filtered for display instead.
 */
export function outline(md, src) {
  const tokens = md.parse(src, {});
  const taken = new Map();
  const heads = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'heading_open') continue;
    const text = headingText(tokens[i + 1]);
    const base = slugify(text) || 'section';
    const nth = taken.get(base) ?? 0;
    taken.set(base, nth + 1);
    heads.push({
      level: Number(t.tag.slice(1)) || 1,
      text,
      id: nth ? `${base}-${nth}` : base,
      // Where it is in the file, which is how the raw view finds it.
      line: t.map?.[0] ?? 0,
    });
  }
  return heads;
}

/**
 * The name the document gives itself, or `''` if it does not give one.
 *
 * Two ways of saying it, in order of how deliberate they are. A header that
 * declares a `title` has been told what to call this document and is believed.
 * Failing that, a document with **exactly one** `<h1>` is a document whose
 * first line is its name -- the usual shape of a README or a design note, where
 * the heading and the file are about the same thing.
 *
 * Exactly one, because the count is the whole of the evidence. Several `<h1>`s
 * are a document of equal parts, and the first of them is a section heading
 * that happens to be at the top; calling the document by it would be picking
 * one chapter's name for the book. No `<h1>` says the same thing in the other
 * direction. In both cases the file's own name is the better answer, and `''`
 * is how this says so.
 *
 * `toc` is the outline the caller has already worked out for the contents list.
 * Taken as an argument because the headings are not worth parsing for twice,
 * and because an outline is exactly the question being asked here.
 *
 * The header is read out of the parse rather than off the top of the text, so
 * that the bar and the card at the top of the document cannot disagree about
 * whether this file has a header at all: `---`, a line of prose, `---` is a
 * setext heading, the rule above refuses it, and this gets no token and no
 * title from it -- it gets an `<h2>` and, having no `<h1>` either, no title.
 *
 * The one shortcut is the `---` test, which is free and exact: the rule only
 * ever fires on line 0, so a file that does not open with the fence cannot
 * have a header, and the parse is spared for every document that has none.
 */
export function documentTitle(md, src, toc) {
  if (src.startsWith('---')) {
    const header = md.parse(src, {}).find((t) => t.type === 'front_matter');
    const declared = header ? headerTitle(header.meta.rows) : '';
    if (declared) return declared;
  }
  const tops = toc.filter((h) => h.level === 1);
  return tops.length === 1 ? tops[0].text.trim() : '';
}

/**
 * Split a document into top-level blocks (paragraphs, headings, lists, code
 * fences, tables, blockquotes...). These are the units the diff works on.
 *
 * Returns the source slices plus the parse `env`, which carries link reference
 * definitions so individual blocks still resolve `[x][ref]` when rendered alone.
 */
export function splitBlocks(md, src) {
  const env = {};
  const tokens = md.parse(src, env);
  const lines = src.split('\n');
  const blocks = [];
  for (const t of tokens) {
    if (t.level !== 0 || t.nesting === -1 || !t.map) continue;
    const text = lines.slice(t.map[0], t.map[1]).join('\n').replace(/\s+$/, '');
    if (text.trim()) blocks.push({ text, line: t.map[0] });
  }
  return { blocks, env };
}

/** The whole document at once, so every block is where the parse says it is. */
export function renderPlain(md, src, env = {}) {
  return md.render(src, { ...env, lineOffset: 0 });
}

export function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Syntax-highlighted markdown source, for the raw view. */
export function highlightSource(src) {
  try {
    return hljs.highlight(src, { language: 'markdown', ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(src);
  }
}

/**
 * Split highlighted HTML into one string per source line, re-balancing tags so
 * a highlight that spans several lines (a fenced block, say) stays valid when
 * each line is wrapped individually.
 */
export function splitHighlightedLines(html) {
  const lines = [];
  const open = [];
  let cur = '';
  for (const m of html.matchAll(/<[^>]+>|[^<]+/g)) {
    const chunk = m[0];
    if (chunk[0] === '<') {
      if (chunk.startsWith('</')) open.pop();
      else if (!chunk.endsWith('/>')) open.push(chunk);
      cur += chunk;
      continue;
    }
    const segments = chunk.split('\n');
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        cur += '</span>'.repeat(open.length);
        lines.push(cur);
        cur = open.join('');
      }
      cur += segments[i];
    }
  }
  lines.push(cur);
  return lines;
}
