// The `---` header block at the top of a markdown file.
//
// Jekyll started it and most things since have copied it, agent skill files
// among them: a fenced block of YAML before the first heading, saying what the
// document *is* rather than being part of what it says. markdown-it has never
// known about it, and the default parse of one is actively bad — the opening
// `---` is a thematic break, and the closing `---` turns everything above it
// into a setext heading, so the whole header becomes one enormous `<h2>` that
// then takes the top row of the contents list.
//
// What is here reads that block for display and for nothing else. No value is
// coerced to a number, a date or a boolean, nothing is resolved and nothing is
// executed: the point is to show the reader what the tool consuming this file
// will be handed, so the text stays the text. That is also what keeps it from
// being wrong in a way that matters — a construct it does not understand is
// shown as the line the author wrote, rather than dropped or thrown over.

/**
 * A mapping entry: `key:`, `key: value`, or either with the key quoted.
 *
 * Deliberately strict about what a key may be, because this same test is what
 * tells a header block from a `---` rule followed by a setext heading. The
 * value is matched lazily so that the *first* colon ends the key — `url:
 * https://…` and `note: "he said: hi"` are a key and a value, not a key with a
 * colon in it.
 */
const ENTRY = /^(?:"([^"]*)"|'([^']*)'|([^\s"'#[{][^:]*?))[ \t]*:(?:[ \t]+(.*))?$/;

/** A sequence item: `-` alone, or `- value`. */
const ITEM = /^-(?:[ \t]+(.*))?$/;

/** `|`, `>`, and the chomping and indent indicators they can carry. */
const BLOCK = /^([|>])[+-]?\d*$/;

const indentOf = (line) => /^[ \t]*/.exec(line)[0].length;

/** Blank lines and whole-line comments are structure, not content. */
const skip = (line) => !line.trim() || /^[ \t]*#/.test(line);

/** The next line with something on it, or -1. */
function next(lines, from) {
  for (let i = from; i < lines.length; i++) if (!skip(lines[i])) return i;
  return -1;
}

/**
 * A plain value, with the quotes YAML would take off taken off.
 *
 * Only the escapes a document header is likely to carry are undone. Anything
 * else is left as the author typed it, because a visible backslash is better
 * than a guess at what it meant.
 */
function scalar(s) {
  const t = s.trim();
  const q = t.length > 1 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0] ? t[0] : '';
  if (q === '"') {
    return t.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
  }
  if (q === "'") return t.slice(1, -1).replace(/''/g, "'");
  // In a plain scalar YAML really does treat ` #` as the start of a comment,
  // so dropping it is not this reader taking liberties with the text.
  return t.replace(/[ \t]+#[ \t].*$/, '').trim();
}

/** `[a, b, c]` as its items: commas, except inside quotes or brackets. */
function flow(s) {
  const out = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((t) => scalar(t)).filter(Boolean);
}

/**
 * The lines of a `|` or `>` value, with their common indent taken off.
 *
 * `|` keeps its line breaks and `>` folds them, which is the one place the
 * difference between the two is worth honouring: a folded value is prose and
 * reads as a paragraph, a literal one is usually a snippet and its shape is
 * half of what it says.
 */
function block(lines, folded) {
  const indents = lines.filter((l) => l.trim()).map(indentOf);
  const cut = indents.length ? Math.min(...indents) : 0;
  const out = lines.map((l) => l.slice(cut));
  while (out.length && !out.at(-1).trim()) out.pop();
  const text = out.join('\n');
  if (!folded) return text;
  return text
    .split(/\n[ \t]*\n/)
    .map((p) => p.split('\n').join(' ').trim())
    .join('\n\n');
}

/** Everything after a `key:`, which may be on the line or under it. */
function readValue(lines, cur, indent, rest) {
  const fold = BLOCK.exec(rest);
  if (fold) {
    const taken = [];
    while (cur.at < lines.length) {
      const line = lines[cur.at];
      if (line.trim() && indentOf(line) <= indent) break;
      taken.push(line);
      cur.at++;
    }
    return { kind: 'text', text: block(taken, fold[1] === '>'), pre: fold[1] === '|' };
  }
  if (rest.startsWith('[') && rest.endsWith(']')) {
    return { kind: 'list', items: flow(rest.slice(1, -1)) };
  }
  if (rest) return { kind: 'text', text: scalar(rest) };

  // Nothing after the colon, so the value is whatever follows under it.
  const at = next(lines, cur.at);
  if (at < 0) return { kind: 'text', text: '' };
  const ind = indentOf(lines[at]);
  // A sequence is allowed to sit at its key's own indent — `tools:` and then
  // `- a` in the same column is as valid as indenting it, and both get written.
  if (ind >= indent && ITEM.test(lines[at].slice(ind))) {
    cur.at = at;
    return readList(lines, cur, ind);
  }
  if (ind > indent) {
    cur.at = at;
    return { kind: 'map', rows: readMap(lines, cur, ind) };
  }
  return { kind: 'text', text: '' };
}

/** `- a`, `- b` at one indent. */
function readList(lines, cur, indent) {
  const items = [];
  while (cur.at < lines.length) {
    if (skip(lines[cur.at])) {
      cur.at++;
      continue;
    }
    if (indentOf(lines[cur.at]) !== indent) break;
    const m = ITEM.exec(lines[cur.at].slice(indent));
    if (!m) break;
    cur.at++;
    // An item that is itself a mapping — `- name: x` — is shown as the line it
    // was written as. A header deep enough to need more than that is better
    // read in the raw view than flattened into a shape this card does not have.
    items.push(scalar(m[1] ?? ''));
  }
  return { kind: 'list', items: items.filter(Boolean) };
}

/** `key: value` pairs at one indent, with their values. */
function readMap(lines, cur, indent) {
  const rows = [];
  while (cur.at < lines.length) {
    const line = lines[cur.at];
    if (skip(line)) {
      cur.at++;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    const text = line.slice(ind);
    const m = ENTRY.exec(text);
    cur.at++;
    if (!m) {
      // Not a field. Kept, as written, so that a header this reader does not
      // fully understand still shows all of itself.
      rows.push({ key: null, value: { kind: 'text', text } });
      continue;
    }
    rows.push({
      key: m[1] ?? m[2] ?? m[3],
      value: readValue(lines, cur, ind, (m[4] ?? '').trim()),
    });
  }
  return rows;
}

/**
 * A header block's lines as rows to show: `{ key, value }` in document order,
 * where `value` is one of
 *
 * - `{ kind: 'text', text, pre }` — a scalar; `pre` when its line breaks matter
 * - `{ kind: 'list', items }` — a sequence, flow or block, as plain strings
 * - `{ kind: 'map', rows }` — a nested mapping, the same shape again
 *
 * A line it cannot read comes back with `key: null` and the line as its text.
 */
export function parseFrontMatter(body) {
  return readMap(body.split('\n'), { at: 0 }, 0);
}

/**
 * Whether these rows are a header block at all, as opposed to the text of a
 * setext heading that happens to be fenced in `---`.
 *
 * `---`, a line of prose, `---` is valid markdown for an `<h2>` and has to keep
 * meaning that. The test is the one YAML itself would apply to the first thing
 * in a mapping: it has to be a field with a name.
 */
export function looksLikeFrontMatter(rows) {
  return rows.length > 0 && rows[0].key != null;
}

/**
 * What the document calls itself, out of the rows of its header, or `''`.
 *
 * `title` is what most things writing one of these call it; `name` is what a
 * skill file calls it. Both count and `title` wins, wherever in the block they
 * happen to sit — a file with both has said which one is its name for itself.
 *
 * Top level only, and only a scalar on one line. A `title:` nested under
 * something else is that thing's title and not the document's, and a `|` block
 * or a list called `title` is something other than a title: what asks for this
 * is one line of a toolbar, and a value that cannot be one is better ignored
 * than clipped into looking like one.
 */
export function headerTitle(rows) {
  for (const want of ['title', 'name']) {
    const value = rows.find((r) => r.key === want)?.value;
    const text = value?.kind === 'text' ? value.text.trim() : '';
    if (text && !text.includes('\n')) return text;
  }
  return '';
}
