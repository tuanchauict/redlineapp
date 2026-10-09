// Block-level diff between a baseline version and the current file.
//
// The unit of comparison is a top-level markdown block (paragraph, heading,
// list, fence, table, ...). A block is either unchanged, added, removed, or —
// when a removal and an addition line up and look alike — modified. A modified
// block is then diffed word by word (see ./inline-diff.js), so only the words
// that actually changed are marked; blocks that resist a readable word diff
// fall back to showing the two versions.
import { diffArrays, diffWordsWithSpace, diffLines } from 'diff';
import { splitBlocks, highlightSource, splitHighlightedLines } from './render.js';
import { inlineDiff } from './inline-diff.js';
import { hashContent } from './hash.js';

const SIMILARITY_THRESHOLD = 0.35;

/**
 * A block's own name: what a check-off records about the block it was made on,
 * so the text can be found again in that version later. Not a change key — a
 * `mod` key is a hash of both sides, and recovering the side you actually read
 * needs the name of that side alone.
 */
export const blockId = (text) => hashContent(text).slice(0, 10);

/** 0..1 overlap between two block sources, used to pair a removal with an addition. */
function similarity(a, b) {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  let common = 0;
  for (const part of diffWordsWithSpace(a, b)) {
    if (!part.added && !part.removed) common += part.value.length;
  }
  return common / max;
}

// The word in the margin naming the kind of change is also the button that
// checks it off: the label that says what happened to a block is the most
// direct place to say "yes, seen it". Hidden until the block is hovered, so a
// document full of edits still reads as a document.
//
// The tick is drawn alongside the word rather than in place of it, because the
// same control reads back the state — once checked, the word goes and the tick
// stays (see `.chg-ok` in the stylesheet).
const TICK =
  '<svg class="i chg-tick" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.4 3 3 6-6.9" /></svg>';

const tagFor = (label) =>
  `<button class="chg-tag" type="button" aria-pressed="false">` +
  `<span class="chg-kind">${label}</span>${TICK}</button>`;

function wrap(kind, key, html, label) {
  return (
    `<div class="chg chg-${kind}" data-chg="${kind}" data-key="${key}">` +
    tagFor(label) +
    html +
    '</div>'
  );
}

/**
 * The blocks you checked off, as you read them, newest check-off first.
 *
 * `from` is one entry per version a check-off was made against — `{ text,
 * blocks }`, the version's whole text and the `blockId`s of the blocks checked
 * in it — and each version is split again here to find them. The reader cannot
 * do this itself: splitting is markdown-it's parse, and markdown-it lives on
 * the page's side of the seam. Each block keeps its own version's references,
 * because it will be rendered as the "before" of a word diff and a `[link][ref]`
 * that resolved when you read it has to resolve again, or the two renders
 * differ at a tag and the block falls back to the two-panel form.
 */
function seenBlocks(md, from) {
  const out = [];
  for (const v of from) {
    const want = new Set(v.blocks);
    const { blocks, env } = splitBlocks(md, v.text);
    for (const b of blocks) {
      if (!want.has(blockId(b.text))) continue;
      out.push({ text: b.text, env: { references: env.references } });
    }
  }
  return out;
}

/**
 * Render `newSrc` as HTML, marking up how it differs from `oldSrc`.
 * Returns { html, stats, changes }, where `changes` names every marked block in
 * document order so the reader can count and remember them one at a time.
 *
 * `checked` is what has been checked off: `keys`, the change keys, and `from`,
 * the versions they were checked against (see `seenBlocks`). A checked block
 * that has since been edited is diffed against the text you checked rather
 * than against the baseline, so what comes back is what moved since you saw it.
 */
export function renderDiff(md, oldSrc, newSrc, slugs = [], checked = {}) {
  const oldDoc = splitBlocks(md, oldSrc);
  const newDoc = splitBlocks(md, newSrc);

  // One env per side, shared across every block rendered from that side: the
  // heading ids are a queue drawn from in document order (see `headingAnchors`),
  // and only the new side gets it — a block that exists only in the baseline
  // must not take an id belonging to one in the file.
  const oldEnv = { references: oldDoc.env.references };
  const newEnv = { references: newDoc.env.references, slugs };
  // A block parsed on its own starts at line 0, so where it really starts is
  // passed in (see `sourceLines`). The baseline's blocks are given a line only
  // when they are the "before" of an edit, and then it is the file's line and
  // not their own: the word diff between the two renders is over the tags as
  // well as the words, so a `<p>` that carried the attribute on one side and
  // not the other would be a change at the very first token, and the whole
  // paragraph would come out as rewritten. A block that was only deleted gets
  // none at all — it is not a line of the file any more, and it is not
  // somewhere the two views should be able to line up on.
  //
  // A block checked off in some other version is an old side too, but with
  // that version's own env (see `seenBlocks`), so it is passed in.
  const renderOld = (text, line, env = oldEnv) => {
    env.lineOffset = line;
    return md.render(text, env);
  };
  const renderNew = (block) => {
    newEnv.lineOffset = block.line;
    return md.render(block.text, newEnv);
  };

  const stats = { added: 0, removed: 0, modified: 0 };
  const changes = [];
  const parts = diffArrays(
    oldDoc.blocks.map((b) => b.text),
    newDoc.blocks.map((b) => b.text),
  );

  /**
   * A change's name, for as long as it is that change.
   *
   * Content-addressed rather than counted from the top of the file, because the
   * name has to survive the document moving around it: check off an edit near
   * the end, add a paragraph at the top, and a change named "the fourth one"
   * would come back while a change named by its own words stays checked. The
   * price is the other way round — edit that wording again and it is a new
   * change, which is right: it is something else to read.
   *
   * Two changes that are word for word the same are told apart by which comes
   * first, so checking one off does not quietly check the other.
   */
  const taken = new Map();
  const nameFor = (kind, ...parts) => kind + hashContent(parts.join('\0')).slice(0, 10);
  // `block` is the file's side of the change, for the check-off to remember
  // (see `blockId`). A removal has no side in the file, so nothing to find
  // again, and carries none.
  const keyFor = (kind, block, ...parts) => {
    const base = nameFor(kind, ...parts);
    const nth = (taken.get(base) ?? 0) + 1;
    taken.set(base, nth);
    const key = nth > 1 ? `${base}.${nth}` : base;
    changes.push(block == null ? { kind, key } : { kind, key, block: blockId(block) });
    return key;
  };

  // --- what you checked off, and has moved since -------------------------
  //
  // A check-off is named by the change's content, so editing the block retires
  // it, and that is right: the new wording is something else to read. What it
  // must not do is send you back to the baseline, where the block is still
  // wholly new — "added" and the whole paragraph lit again, when the only thing
  // new to you is a clause. So a block that is a change, and that looks like a
  // block you checked off, is diffed against what you checked.
  //
  // A checked block still in the file word for word has not moved since, and is
  // not a candidate: matching it to some other block would be reading one
  // paragraph as an edit of its neighbour. Each is used once — one check-off is
  // one block you read. And "looks like" is `similarity` at the same threshold
  // the block pass pairs a removal with an addition at, because two notions of
  // "the same block, edited" that disagree would be a bug findable only by eye.
  const keys = new Set(checked.keys ?? []);
  const inFile = new Set(newDoc.blocks.map((b) => b.text));
  const seen = seenBlocks(md, checked.from ?? []).filter((s) => !inFile.has(s.text));
  const claimed = new Set();
  // The best of them at `floor` or above; on a tie the newest check-off, which
  // is the one you read last. Most of the time there is nothing to look at.
  const lastSeen = (text, floor) => {
    let best = null;
    let score = -1;
    for (const s of seen) {
      if (claimed.has(s)) continue;
      const sim = similarity(s.text, text);
      if (sim >= floor && sim > score) [best, score] = [s, sim];
    }
    if (best) claimed.add(best);
    return best;
  };

  const addBlock = (block) => {
    // Checked off as it stands, and so still exactly what was read: leave it.
    const asIs = keys.has(nameFor('add', block.text));
    const last = !asIs && seen.length ? lastSeen(block.text, SIMILARITY_THRESHOLD) : null;
    if (last) return modBlock(last.text, block, last.env);
    stats.added++;
    return wrap('add', keyFor('add', block.text, block.text), renderNew(block), 'added');
  };
  const delBlock = (text) => {
    stats.removed++;
    return wrap('del', keyFor('del', null, text), renderOld(text), 'removed');
  };
  // Counted as `modified`, against a checked-off block as much as against the
  // baseline: `~` is what is drawn, so `~` is what the counter says.
  const modBlock = (before, after, env = oldEnv) => {
    stats.modified++;
    const oldHtml = renderOld(before, after.line, env);
    const newHtml = renderNew(after);
    const key = keyFor('mod', after.text, before, after.text);
    const head = `data-chg="mod" data-key="${key}">${tagFor('changed')}`;

    // Preferred: show the new text with the words that changed marked in place.
    const inline = inlineDiff(oldHtml, newHtml);
    if (inline) {
      return `<div class="chg chg-mod chg-inline" ${head}${inline}</div>`;
    }
    // Rewritten beyond recognition (or not prose at all): keep the two versions
    // apart rather than interleaving them into noise.
    //
    // Rendered again without the line, now that nothing is being diffed against
    // it: the file has one block on that line, and a second copy of it folded
    // inside a `details` — measuring as nothing at all while it is shut — is
    // not a place the two views could agree on.
    const beforeHtml = renderOld(before, undefined, env);
    return (
      `<div class="chg chg-mod" ${head}${newHtml}` +
      `<details class="chg-before"><summary>before</summary>${beforeHtml}</details>` +
      '</div>'
    );
  };

  // An edit of a baseline block that you already checked off, and that has
  // been edited again: show the newest edit, not the first one replayed from
  // the baseline. Only when the block you checked is at least as close to the
  // file as the baseline is — otherwise this is some other block that happens
  // to resemble one you read, and the baseline is the better account of it.
  const editBlock = (before, after, sim) => {
    const asIs = keys.has(nameFor('mod', before, after.text));
    const last = !asIs && seen.length ? lastSeen(after.text, sim) : null;
    return last ? modBlock(last.text, after, last.env) : modBlock(before, after);
  };

  // Pair up a run of removals with the run of additions that follows it: an
  // aligned pair that is similar enough reads as an edit, not a delete+insert.
  // `removed` is the baseline's text; `added` is blocks of the file, because
  // those are the ones that know which line they are on.
  const emitRun = (removed, added) => {
    let out = '';
    const paired = Math.min(removed.length, added.length);
    let i = 0;
    for (; i < paired; i++) {
      const sim = similarity(removed[i], added[i].text);
      if (sim >= SIMILARITY_THRESHOLD) {
        out += editBlock(removed[i], added[i], sim);
      } else {
        out += delBlock(removed[i]);
        out += addBlock(added[i]);
      }
    }
    for (let j = i; j < removed.length; j++) out += delBlock(removed[j]);
    for (let j = i; j < added.length; j++) out += addBlock(added[j]);
    return out;
  };

  // The diff is over the block texts, but what gets rendered is the blocks: a
  // run of the file's own blocks, in order, taken as each part claims them.
  let ni = 0;
  const takeNew = (n) => newDoc.blocks.slice(ni, (ni += n));

  let html = '';
  let pendingRemoved = [];
  for (const part of parts) {
    if (part.removed) {
      pendingRemoved.push(...part.value);
    } else if (part.added) {
      html += emitRun(pendingRemoved, takeNew(part.value.length));
      pendingRemoved = [];
    } else {
      if (pendingRemoved.length) {
        html += emitRun(pendingRemoved, []);
        pendingRemoved = [];
      }
      for (const block of takeNew(part.value.length)) html += renderNew(block);
    }
  }
  if (pendingRemoved.length) html += emitRun(pendingRemoved, []);

  return { html, stats, changes };
}

/**
 * Raw source view: markdown syntax highlighting, plus line-level change marks
 * when there is a baseline to compare against. Removed lines are pulled from
 * the highlighted *old* source so they keep their colours too.
 */
export function renderRawDiff(oldSrc, newSrc) {
  const newLines = splitHighlightedLines(highlightSource(newSrc));
  // `data-line` is where the line sits in the file, and it is how the contents
  // list finds a heading in this view: there are no ids here to jump to. Only
  // lines that are in the file get one — a removed line is not anywhere in it.
  const line = (html, { cls = '', chg = '', at = null } = {}) =>
    `<span class="raw-line${cls ? ' ' + cls : ''}"` +
    (at == null ? '' : ` data-line="${at}"`) +
    (chg ? ` data-chg="${chg}"` : '') +
    `>${html}</span>`;

  /** A run of the file's own lines, each knowing which line it is. */
  const fromNew = (start, n, opts) =>
    newLines
      .slice(start, n == null ? undefined : start + n)
      .map((l, k) => line(l, { ...opts, at: start + k }))
      .join('');

  if (oldSrc == null) {
    return `<pre class="raw">${fromNew(0, null)}</pre>`;
  }

  const oldLines = splitHighlightedLines(highlightSource(oldSrc));
  let out = '';
  let oi = 0;
  let ni = 0;
  for (const part of diffLines(oldSrc, newSrc)) {
    const n = part.count ?? part.value.split('\n').length - 1;
    if (part.added) {
      out += fromNew(ni, n, { cls: 'raw-add', chg: 'add' });
      ni += n;
    } else if (part.removed) {
      for (const l of oldLines.slice(oi, oi + n)) out += line(l, { cls: 'raw-del' });
      oi += n;
    } else {
      out += fromNew(ni, n);
      ni += n;
      oi += n;
    }
  }
  // Anything left over (no trailing newline in the source, say).
  out += fromNew(ni, null);
  return `<pre class="raw">${out}</pre>`;
}
