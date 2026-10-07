// Word-level diff *inside* a changed block.
//
// This runs on the rendered HTML of the two versions, not on the markdown
// source: injecting markers into the source breaks the syntax they land in
// (emphasis runs, link destinations, fences), whereas an HTML token stream can
// be diffed safely as long as tags are never split from their partners.
//
// Tokens are "optional whitespace + one tag or one word". Matching ignores
// whitespace differences, so a reflowed paragraph is not one big change, but
// output always uses the token verbatim, so spacing survives.
import { diffArrays } from 'diff';

const BLOCK_TAG =
  /^<\/?(?:address|article|aside|blockquote|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)\b/i;

// Adjacent changes separated by at most this many unchanged words are merged,
// so a rewritten sentence reads as one phrase rather than a row of confetti.
const BRIDGE_WORDS = 3;
// Past these, the paragraph has been rewritten rather than edited, and an
// inline diff is less readable than simply showing the two versions.
const MIN_SIMILARITY = 0.4;
const MAX_GROUPS = 12;
const MAX_HTML = 200_000;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

const tokenize = (html) => html.match(/\s*(?:<[^>]+>|[^<\s]+)/g) ?? [];
const norm = (t) => t.replace(/\s+/g, ' ').trim();
const isTag = (t) => t.trimStart().startsWith('<');
const isBlock = (t) => BLOCK_TAG.test(t.trimStart());
const isWord = (t) => !isTag(t) && norm(t) !== '';

/**
 * Indices of tags whose partner lies outside `tokens`. A mark may not span
 * one of these, or it would interleave with an element it does not contain
 * — `<strong><ins>x</strong>y</ins>` and friends.
 */
function unpaired(tokens) {
  const open = [];
  const loose = new Set();
  tokens.forEach((t, i) => {
    if (!isTag(t)) return;
    const m = /^<(\/?)([a-zA-Z][\w-]*)/.exec(t.trimStart());
    if (!m) return; // comment or doctype: harmless
    const [, closing, name] = m;
    if (VOID.has(name.toLowerCase()) || t.trimEnd().endsWith('/>')) return;
    if (!closing) {
      open.push({ name, i });
    } else if (open.at(-1)?.name === name) {
      open.pop();
    } else {
      loose.add(i); // closes something opened before this run
    }
  });
  for (const { i } of open) loose.add(i); // closed after this run
  return loose;
}

/** Wrap `body` without swallowing the whitespace that positions it. */
function mark(tag, cls, s) {
  const lead = s.match(/^\s*/)[0];
  const body = s.slice(lead.length);
  return body ? `${lead}<${tag} class="${cls}">${body}</${tag}>` : s;
}

/**
 * Deleted text only: the old version's tags are dropped so nothing unbalances,
 * but the whitespace in front of them is kept — it is what separates words.
 */
function emitDel(tokens) {
  return mark('del', 'w-del', tokens.map((t) => (isTag(t) ? t.match(/^\s*/)[0] : t)).join(''));
}

/** Added tokens keep the new version's structure; marks stop at tags they don't own. */
function emitAdd(tokens) {
  const loose = unpaired(tokens);
  let out = '';
  let buf = [];
  const flush = () => {
    if (buf.length) out += mark('ins', 'w-add', buf.join(''));
    buf = [];
  };
  tokens.forEach((t, i) => {
    if (isBlock(t) || loose.has(i)) {
      flush();
      out += t;
    } else {
      buf.push(t);
    }
  });
  flush();
  return out;
}

/** Duplicate short unchanged runs into both sides so changes read as phrases. */
function bridge(ops) {
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const prev = out.at(-1);
    const next = ops[i + 1];
    const short = op.tokens.filter(isWord).length <= BRIDGE_WORDS;
    if (
      op.t === 'eq' &&
      short &&
      prev?.t !== undefined &&
      prev.t !== 'eq' &&
      next &&
      next.t !== 'eq' &&
      !op.tokens.some(isBlock)
    ) {
      out.push({ t: 'del', tokens: op.tokens }, { t: 'add', tokens: op.tokens });
    } else {
      out.push(op);
    }
  }
  return out;
}

/**
 * Mark up `newHtml` with what changed relative to `oldHtml`.
 * Returns the annotated HTML, or null when a word diff would not help.
 */
export function inlineDiff(oldHtml, newHtml) {
  // Diagrams are one opaque node (or thousands of SVG elements); a word diff
  // of either is meaningless.
  if (oldHtml.length + newHtml.length > MAX_HTML) return null;
  if (/<svg|class="mermaid"/.test(oldHtml) || /<svg|class="mermaid"/.test(newHtml)) return null;

  const before = tokenize(oldHtml);
  const after = tokenize(newHtml);
  if (!before.length || !after.length) return null;

  const parts = diffArrays(before, after, { comparator: (a, b) => norm(a) === norm(b) });

  let same = 0;
  let added = 0;
  let removed = 0;
  let groups = 0;
  let inGroup = false;
  for (const p of parts) {
    const n = p.value.filter(isWord).length;
    if (p.added) added += n;
    else if (p.removed) removed += n;
    else same += n;

    const change = Boolean(p.added || p.removed);
    if (change && !inGroup) groups++;
    inGroup = change;
  }

  if (!added && !removed) return null; // only tags moved — not worth marking
  if (groups > MAX_GROUPS) return null;
  if (same / (same + Math.max(added, removed)) < MIN_SIMILARITY) return null;
  // A removal that spans structure (a whole list item, a table row) has no
  // valid place to sit inline — text loose in a <ul> gets reparented by the
  // browser and lands somewhere else entirely. Show the two versions instead.
  if (parts.some((p) => p.removed && p.value.some(isBlock))) return null;

  const ops = bridge(
    parts.map((p) => ({ t: p.added ? 'add' : p.removed ? 'del' : 'eq', tokens: p.value })),
  );

  let html = '';
  for (let i = 0; i < ops.length; ) {
    if (ops[i].t === 'eq') {
      html += ops[i].tokens.join('');
      i++;
      continue;
    }
    // Collect the whole run of changes, then show old text before new.
    const del = [];
    const add = [];
    for (; i < ops.length && ops[i].t !== 'eq'; i++) {
      (ops[i].t === 'del' ? del : add).push(...ops[i].tokens);
    }
    // Any block tags the addition opens with come first, so the deleted text
    // lands inside the new element rather than in front of it.
    let lead = 0;
    while (lead < add.length && isBlock(add[lead])) lead++;
    html += add.slice(0, lead).join('') + emitDel(del) + emitAdd(add.slice(lead));
  }
  return html;
}
