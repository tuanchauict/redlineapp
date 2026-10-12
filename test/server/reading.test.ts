import { test } from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert';
import { rootUrl } from '../../src/hosts/node/root.js';
import { createServer } from '../../src/hosts/node/server.js';
import { createMarkdown, outline, slugify } from '../../src/core/render.js';
import { renderDiff } from '../../src/core/diff.js';
import { renderDocument, titleOf as docTitleOf } from '../../src/core/document.js';
import { clientFor, mdPage, pageJs, portOf, scratch, type Reply } from '../support.js';

const tmp = scratch();

let server, base, get, postDoc, doc;
const file = path.join(tmp, 'sample.md');

test('first open renders clean', async () => {
  fs.copyFileSync(rootUrl('sample.md'), file);

  ({ server } = await createServer({ file }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${portOf(server)}`;
  get = clientFor(base);
  postDoc = (p) => get(p, { method: 'POST' });

  // First open: no changes.
  doc = await get('/api/doc');
  assert.deepStrictEqual(doc.stats, { added: 0, removed: 0, modified: 0 }, 'fresh open is clean');
  assert.match(doc.html, /<h1 [^>]*id="project-notes">Project Notes<\/h1>/);
  assert.match(doc.html, /markdown-alert-note/, 'GitHub alert rendered');
  assert.match(doc.html, /<table[ >]/, 'table rendered');
  assert.match(doc.html, /hljs-keyword|<code class="language-js">/, 'code highlighted');
  assert.ok(!doc.html.includes('data-chg'), 'no change marks yet');
});

// Listen for the live-reload event.
let reader;
test('live-reload event fired', async () => {
  const events = [];
  const es = await fetch(base + '/events');
  reader = es.body.getReader();
  (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split('\n')) {
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
      }
    }
  })();

  // Simulate an AI edit.
  const edited = fs
    .readFileSync(file, 'utf8')
    .replace('Some text that the AI will rewrite later on.', 'Some text that the AI rewrote, with an extra clause.')
    .replace('A paragraph that will be deleted entirely.\n', '')
    .replace('## Goals', '## Goals\n\nA brand new paragraph inserted by the assistant.');
  fs.writeFileSync(file, edited);

  await new Promise((r) => setTimeout(r, 600));
  assert.ok(events.some((e) => e.type === 'change'), 'change event pushed over SSE');
});

// paragraph-level diff.
test('paragraph diff', async () => {
  doc = await get('/api/doc');
  assert.deepStrictEqual(doc.stats, { added: 1, removed: 1, modified: 1 }, `stats: ${JSON.stringify(doc.stats)}`);
  assert.match(doc.html, /chg chg-add[\s\S]*brand new paragraph/, 'insertion marked added');
  assert.match(doc.html, /chg chg-mod[\s\S]*AI/, 'edit marked changed');
  assert.match(doc.html, /chg chg-del[\s\S]*deleted entirely/, 'deletion shown');

  // the edited paragraph is diffed word by word, in place
  const mod = doc.html.slice(doc.html.indexOf('chg-mod'));
  assert.match(mod, /<del class="w-del">will rewrite later on\.<\/del>/, 'replaced words struck out');
  assert.match(mod, /<ins class="w-add">rewrote, with an extra clause\.<\/ins>/, 'new words marked');
  assert.ok(mod.includes('Some text that the AI <del'), 'untouched words left alone');
  assert.ok(!mod.includes('chg-before'), 'no before-disclosure when the words are marked in place');
  // untouched blocks must stay unmarked
  const intro = doc.html.slice(0, doc.html.indexOf('Intro paragraph'));
  assert.ok(!intro.includes('chg-'), 'unchanged intro not marked');
  console.log('✓ paragraph diff:', doc.stats);
});

// Raw view: syntax highlighting + line marks.
// The lines that are not marked removed must reconstruct the file exactly —
// this catches any off-by-one in the line/diff alignment.
function rawLines(html) {
  return [...html.matchAll(/<span class="raw-line([^"]*)"[^>]*>([\s\S]*?)<\/span>\n?(?=<span class="raw-line|<\/pre>)/g)]
    .map(([, cls, body]) => ({
      removed: cls.includes('raw-del'),
      text: body
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&amp;/g, '&'),
    }));
}

test('raw view: highlighted, line-aligned, marks changes', async () => {
  assert.match(doc.rawHtml, /raw-add[\s\S]*brand new paragraph/, 'raw view marks additions');
  assert.match(doc.rawHtml, /raw-del/, 'raw view marks removals');
  assert.match(doc.rawHtml, /class="hljs-section"/, 'raw view highlights markdown headings');
  assert.match(doc.rawHtml, /class="hljs-(bullet|code|string|link)"/, 'raw view highlights other tokens');
  const kept = rawLines(doc.rawHtml).filter((l) => !l.removed).map((l) => l.text);
  assert.strictEqual(
    kept.join('\n'),
    fs.readFileSync(file, 'utf8'),
    'raw view reproduces the source exactly',
  );
  assert.ok(
    rawLines(doc.rawHtml).some((l) => l.removed && l.text.includes('deleted entirely')),
    'removed lines still shown in raw view',
  );
});

// no baseline -> still highlighted, still exact
test('raw view without baseline', async () => {
  const plainRaw = (await get('/api/doc?baseline=none')).rawHtml;
  assert.match(plainRaw, /class="hljs-section"/, 'raw view highlighted without a baseline');
  assert.strictEqual(
    rawLines(plainRaw).map((l) => l.text).join('\n'),
    fs.readFileSync(file, 'utf8'),
    'undiffed raw view reproduces the source exactly',
  );
  assert.ok(!plainRaw.includes('raw-add') && !plainRaw.includes('raw-del'), 'no marks without a baseline');
});

// The same place in both views.
// Switching between the render and the source keeps your place, and the place
// is a line of the file: the raw view is the file's lines and the rendered view
// now says which line each block came from. Neither is any use to the other
// unless the lines are the file's own and they only ever go up — the page finds
// a place by binary search over them (see `sourceAt` in public/app.js).
test('both views name the same lines', async () => {
  const linesIn = (html) => [...html.matchAll(/ data-line="(\d+)"/g)].map(([, n]) => +n);
  const docLines = linesIn(doc.html);
  assert.ok(docLines.length > 5, `every block says where it is: ${docLines}`);
  assert.deepStrictEqual(
    docLines,
    [...docLines].sort((a, b) => a - b),
    `and the lines only go up: ${docLines}`,
  );
  assert.strictEqual(new Set(docLines).size, docLines.length, 'each line claimed once');
  // A block that is only in the baseline is not a line of the file, and a "before"
  // folded inside a `details` measures as nothing while it is shut: neither is
  // somewhere the other view could put you.
  for (const [, inside] of doc.html.matchAll(/<div class="chg chg-del"[^>]*>([\s\S]*?)<\/div>/g)) {
    assert.ok(!inside.includes('data-line='), 'a deleted block is nowhere in the file');
  }
  for (const [, inside] of doc.html.matchAll(/<details class="chg-before">([\s\S]*?)<\/details>/g)) {
    assert.ok(!inside.includes('data-line='), 'and neither is the old copy of a rewrite');
  }
  {
    // The line named is the line the block starts on, counting from zero.
    const mdLines = createMarkdown();
    const src = '# Title\n\nA first paragraph, plain and simple.\n\n- a\n- b\n\n```js\nconst x = 1;\n```\n\nLast para.\n';
    const at = (tag) =>
      +new RegExp(`<${tag} data-line="(\\d+)"`).exec(renderDocument(mdLines, src, null).html)[1];
    assert.strictEqual(at('h1'), 0, 'the heading is the first line');
    assert.strictEqual(at('ul'), 4, 'the list starts where the list starts');
    assert.strictEqual(at('code'), 7, 'and a fence at its fence');
    // Threaded through the diff too, where each block is rendered on its own and
    // would otherwise believe it starts at line 0.
    const edited = src.replace('plain and simple', 'plain and edited');
    const diffed = renderDiff(mdLines, src, edited).html;
    assert.deepStrictEqual(linesIn(diffed), [0, 2, 4, 7, 11], `diffed blocks keep the file's lines`);
    // The line is on the baseline's copy of a *modified* block as well, and has
    // to be: the word diff runs over the tags, so an attribute on one side only
    // would read as a change at the very first token and the whole paragraph
    // would come out rewritten instead of two words of it.
    assert.match(diffed, /chg-inline/, 'a small edit still reads as a small edit');
  }
  assert.match(pageJs, /function sourceAt/, 'the page reads its place off as a line');
  assert.match(pageJs, /function scrollToSource/, 'and puts it back on the other side');
  assert.match(pageJs, /const at = sourceAt\(\);[\s\S]{0,200}scrollToSource\(at\)/, 'across a view switch');
});

// The document's own headings.
// One walk of the source gives both the contents list down the side and the ids
// the rendered headings carry, so the two cannot disagree about what is in the
// document or where a link into it lands.
test('contents list + heading anchors', async () => {
  assert.deepStrictEqual(
    doc.toc.map((h) => [h.level, h.text, h.id]),
    [
      [1, 'Project Notes', 'project-notes'],
      [2, 'Goals', 'goals'],
    ],
    `the headings, in order: ${JSON.stringify(doc.toc)}`,
  );
  const srcLines = fs.readFileSync(file, 'utf8').split('\n');
  for (const h of doc.toc) {
    assert.match(doc.html, new RegExp(`<h${h.level} [^>]*id="${h.id}"`), `#${h.id} is on its own heading`);
    // The raw view has no ids to jump to, so a row finds the line instead — and
    // that line had better be the heading it claims.
    assert.match(doc.rawHtml, new RegExp(`data-line="${h.line}"`), `#${h.id} names a line`);
    assert.match(srcLines[h.line], new RegExp(`^#+\\s+${h.text}$`), `line ${h.line} is "${h.text}"`);
  }

  const mdToc = createMarkdown();
  assert.strictEqual(slugify('Why *this*, and not That?'), 'why-this-and-not-that', 'GitHub-style slug');
  // Two headings with the same words must not share an id, or the second link
  // into the document quietly goes to the first one.
  const dupes = outline(mdToc, '# Notes\n\n## Notes\n\n### Notes\n');
  assert.deepStrictEqual(dupes.map((h) => h.id), ['notes', 'notes-1', 'notes-2'], 'repeats told apart');
  assert.deepStrictEqual(dupes.map((h) => h.level), [1, 2, 3], 'each keeps its own level');
  assert.strictEqual(outline(mdToc, '# `code` and ![a pic](x.png)\n')[0].text, 'code and a pic', 'a heading reads as words');
  assert.strictEqual(outline(mdToc, '# !!!\n')[0].id, 'section', 'a heading with no words still gets an id');

  // A heading that exists only in the baseline must not take the id belonging to
  // one in the file: the ids are handed to the renderer as a queue, and a removed
  // block drawing from it would shift every id after it along by one.
  const hadMore = '# Kept\n\nBody.\n\n## Dropped\n\nGone.\n\n## Last\n\nEnd.\n';
  const hasLess = '# Kept\n\nBody.\n\n## Last\n\nEnd.\n';
  const afterDrop = renderDiff(mdToc, hadMore, hasLess, outline(mdToc, hasLess).map((h) => h.id)).html;
  assert.match(afterDrop, /<h1 [^>]*id="kept">/, 'the kept heading keeps its id');
  assert.match(afterDrop, /<h2 [^>]*id="last">/, 'and so does the one after the removal');
  assert.ok(!/<h2 [^>]*id="[^"]*">Dropped/.test(afterDrop), 'the removed heading takes none');
});

// Checking a change off.
// Not the same as marking the version read. The read mark says "all of this is
// seen" and moves what everything is measured from; this says "that bit is
// seen", one block at a time, and leaves the rest of what moved still marked.
test('check a change off', async () => {
  assert.strictEqual(doc.changes.length, 3, `every marked block is named: ${JSON.stringify(doc.changes)}`);
  assert.deepStrictEqual(doc.changes.map((c) => c.kind).sort(), ['add', 'del', 'mod'], 'and says which kind');
  assert.deepStrictEqual(doc.acked, [], 'nothing checked off to begin with');
  for (const c of doc.changes) {
    assert.ok(doc.html.includes(`data-key="${c.key}"`), `${c.key} is on the block it names`);
  }
  assert.strictEqual(new Set(doc.changes.map((c) => c.key)).size, 3, 'no two changes share a name');

  const oneKey = doc.changes[0].key;
  const ackRes = (await (
    await fetch(`${base}/api/ack?key=${oneKey}`, { method: 'POST' })
  ).json()) as Reply;
  assert.deepStrictEqual(ackRes.acked, [oneKey], 'the change is remembered as checked');
  // The document is not rebuilt for it: the page has already hidden the mark, and
  // it knows what it clicked.
  assert.deepStrictEqual(Object.keys(ackRes), ['acked'], 'and nothing else comes back');
  assert.deepStrictEqual((await get('/api/doc')).acked, [oneKey], 'and it is read back with the document');
  // Still counted, though: a checked change is one, it is just not one you are
  // being asked to look at. Subtracting them is the page's business.
  assert.deepStrictEqual((await get('/api/doc')).stats, doc.stats, 'the stats are left alone');
  // A different baseline is a different set of changes, and marks made against
  // one must not be thrown away by looking at the document against another.
  assert.deepStrictEqual((await get('/api/doc?baseline=none')).acked, [oneKey], 'kept across baselines');

  await fetch(`${base}/api/ack?key=${oneKey}&on=0`, { method: 'POST' });
  assert.deepStrictEqual((await get('/api/doc')).acked, [], 'and it can be brought back');
  for (const c of doc.changes) await fetch(`${base}/api/ack?key=${c.key}`, { method: 'POST' });
  assert.deepStrictEqual((await get('/api/doc')).acked, doc.changes.map((c) => c.key), 'all three, in the order marked');
  const clearedAcks = (await (
    await fetch(`${base}/api/ack?clear=1`, { method: 'POST' })
  ).json()) as Reply;
  assert.deepStrictEqual(clearedAcks.acked, [], 'and cleared in one call');
  // Naming no change is a mistake, not an empty instruction to carry out.
  assert.strictEqual((await fetch(`${base}/api/ack`, { method: 'POST' })).status, 400, 'a change must be named');
});

// What can be compared against.
// One list, not two. The versions are the history; "last read" and "nothing"
// are not rows of their own but a mark on a row and the absence of a
// comparison, so the payload has no second, toolbar-sized list to disagree
// with it.
test('the history is the whole list', async () => {
  assert.ok(!('options' in doc), 'no shortlist of versions for a toolbar');
  assert.ok(doc.history.some((h) => h.current), 'the version on disk is in the list');
  assert.ok(doc.history.some((h) => h.baseline), 'so is the one counted as read');
  assert.strictEqual((await get('/api/doc?baseline=read')).baseline, 'read', '"last read" honoured');
  const none = await get('/api/doc?baseline=none');
  assert.deepStrictEqual(none.stats, { added: 0, removed: 0, modified: 0 }, 'baseline=none disables diff');
  console.log('✓ the history is the whole list', doc.history.length, 'versions');
});

// Mark read resets the baseline.
let older;
test('mark read resets the baseline, and an older snapshot is still comparable', async () => {
  const marked = await postDoc('/api/mark-read');
  assert.deepStrictEqual(marked.stats, { added: 0, removed: 0, modified: 0 }, 'mark-read clears changes');
  // The read mark moves to the newest row, which is how the list shows it: the
  // `read` chip is the only thing that says where the mark ended up.
  assert.ok(marked.history.find((h) => h.baseline)?.current, 'the read mark lands on the newest version');
  assert.ok(!('canUndoRead' in marked), 'and the payload no longer offers to take it back');
  older = doc.history.find((h) => !h.current);
  if (older) {
    const back = await get('/api/doc?baseline=snap:' + older.hash);
    assert.ok(back.stats.added + back.stats.modified + back.stats.removed > 0, 'older snapshot still diffable');
    // The server says which version it compared against, and the list highlights
    // that row — there is nowhere else for it to be shown.
    assert.strictEqual(back.baseline, 'snap:' + older.hash, 'and it says which one it used');
  }
});

// ...and the way back is the list, not an undo.
// Marking read moves a pointer; the version it came off is still in the list
// and still comparable, which is the whole reason there is no undo. Asking for
// it by hash has to give back exactly what the undo used to.
test('the version marked read off is one click away', async () => {
  if (older) {
    const back = await get('/api/doc?baseline=snap:' + older.hash);
    assert.deepStrictEqual(back.stats, doc.stats, 'the version marked read off is still comparable');
  }
  // Marking read twice over is a no-op rather than an error, since the key does
  // not know what the list knows.
  await fetch(base + '/api/mark-read', { method: 'POST' });
  assert.deepStrictEqual(
    (await get('/api/doc')).stats,
    { added: 0, removed: 0, modified: 0 },
    'marking read again still works',
  );
  // Any row can be marked read from its menu, and an older one is "read up to
  // here": the mark goes back to it, and the version on disk is one more away.
  if (older) {
    const upTo = await postDoc('/api/mark-read?at=' + older.hash);
    assert.strictEqual(upTo.history.find((h) => h.baseline)?.hash, older.hash, 'mark-read?at= moves the mark there');
    assert.deepStrictEqual(upTo.stats, doc.stats, 'and the marks are what changed since it');
    const again = await postDoc('/api/mark-read');
    assert.ok(again.history.find((h) => h.baseline)?.current, 'and without it, back to the version on disk');
  }
  // Nothing is kept for an undo that no longer exists, including in a store
  // written by a version that had one.
  const indexDir = path.join(process.env.REDLINE_HOME, 'docs');
  for (const name of fs.readdirSync(indexDir)) {
    const idx = JSON.parse(fs.readFileSync(path.join(indexDir, name), 'utf8'));
    assert.ok(!('prevBaseline' in idx), 'and the store keeps no pointer for it');
  }
});

// Snapshots survive a restart.
let second, base2, get2, after;
test('baseline persisted across restarts', async () => {
  server.close();
  await reader.cancel().catch(() => {});
  fs.appendFileSync(file, '\nA late addition after restart.\n');
  second = await createServer({ file });
  await new Promise<void>((r) => second.server.listen(0, '127.0.0.1', r));
  base2 = `http://127.0.0.1:${portOf(second.server)}`;
  get2 = clientFor(base2);
  after = await get2('/api/doc');
  assert.strictEqual(after.stats.added, 1, `restart diff vs stored baseline: ${JSON.stringify(after.stats)}`);
});

// Compare against an arbitrary earlier snapshot.
// The versions live in the sidebar list, not in the toolbar dropdown: a history
// gets long, and a one-line bar has no room to say which version is which.
let oldest, vsOldest;
test('compare against earlier snapshot', async () => {
  const snaps = after.history.filter((h) => !h.current);
  assert.ok(snaps.length >= 1, `older versions listed: ${JSON.stringify(after.history.map((h) => h.hash))}`);
  assert.ok(snaps.every((h) => typeof h.ts === 'number'), 'versions carry a timestamp for labelling');
  assert.ok(after.history.some((h) => h.current), 'the version on disk is marked');
  assert.ok(after.history.some((h) => h.baseline), 'the version counted as read is marked');

  // The oldest snapshot is the original file, so diffing against it must report
  // strictly more changes than diffing against the more recent baseline.
  oldest = snaps.at(-1);
  vsOldest = await get2('/api/doc?baseline=snap:' + oldest.hash);
  const total = (s) => s.added + s.removed + s.modified;
  assert.ok(
    total(vsOldest.stats) > total(after.stats),
    `oldest snapshot shows more changes: ${JSON.stringify(vsOldest.stats)} vs ${JSON.stringify(after.stats)}`,
  );
  assert.match(vsOldest.html, /chg chg-(add|mod|del)/, 'earlier-version diff is marked up');
  console.log('✓ compare against earlier snapshot', oldest.hash, vsOldest.stats);
});

// One version, by itself.
// Reading a version on its own is the same payload rendered another way: the
// version picked is already `base`, so the page renders it plainly, exactly as
// `adopt` does with the switch on — and keeps the bar naming the file as it is.
test('an older version reads by itself', async () => {
  const solo = renderDocument(mdPage, vsOldest.base, null);
  assert.ok(!/chg chg-/.test(solo.html), 'a version read by itself carries no marks');
  assert.deepStrictEqual(solo.changes, [], 'and nothing to count or walk');
  assert.notStrictEqual(
    solo.html,
    renderDocument(mdPage, vsOldest.text, null).html,
    'and it is that version, not the file as it is',
  );
  assert.strictEqual(
    docTitleOf(mdPage, vsOldest.text),
    vsOldest.title,
    'the title is still the file\'s',
  );
});

// The version chosen stays chosen.
// Picking a version out of the history is a reading position as much as a
// scroll offset is, so it is kept per document rather than reset on every
// open. A document is asked for with `last:<default>` — "whatever this one was
// last compared against, and the default only if it never has been" — and that
// is what the page sends whenever it *shows* a document rather than being told
// to compare against something.
test('the chosen version is remembered', async () => {
  assert.strictEqual(
    (await get2('/api/doc')).baseline,
    'snap:' + oldest.hash,
    'an unqualified open compares against the version last chosen',
  );
  assert.strictEqual(
    (await get2('/api/doc?baseline=last:read')).baseline,
    'snap:' + oldest.hash,
    'and so does the form the page actually sends',
  );
  // The default travels in the token as a fallback, not an instruction: a
  // document with a choice of its own keeps it even when the setting says git.
  assert.strictEqual(
    (await get2('/api/doc?baseline=last:git:HEAD')).baseline,
    'snap:' + oldest.hash,
    'a remembered choice beats the default that came with the request',
  );
  // Reading the file with no comparison at all is not a choice of version, so it
  // must not overwrite one. The page keeps that as its own switch.
  assert.strictEqual((await get2('/api/doc?baseline=none')).baseline, 'none', 'none is honoured');
  assert.strictEqual(
    (await get2('/api/doc')).baseline,
    'snap:' + oldest.hash,
    'and reading with nothing compared does not forget what was chosen',
  );
});

// Cleaning up history to a version.
// The one call that deletes rather than adds, so: it names what to drop, it
// refuses to drop the newest, and a baseline it orphans has to land somewhere.
test('clean up history to a version', async () => {
  const before = after.history.length;
  const cutAt = after.history.at(-2) ?? after.history.at(-1);
  const pruned = (await (
    await fetch(base2 + '/api/prune?upto=' + cutAt.hash, { method: 'POST' })
  ).json()) as Reply;
  assert.ok(pruned.removed >= 1, `something was forgotten: ${pruned.removed}`);
  assert.strictEqual(pruned.history.length, before - pruned.removed, 'the list shrank by what went');
  assert.ok(pruned.history.some((h) => h.current), 'the version on disk survives a clean-up');
  assert.ok(
    !pruned.history.some((h) => h.hash === cutAt.hash),
    'the version named is gone, not kept',
  );
  assert.ok(
    pruned.history.some((h) => h.baseline),
    'the baseline still points at a version that exists',
  );
  assert.ok(pruned.baselineAvailable, 'and that version can still be read back and diffed');
  // Nothing older than the newest can be dropped: it is the comparison target.
  const head = pruned.history.find((h) => h.current);
  const noop = (await (
    await fetch(base2 + '/api/prune?upto=' + head.hash, { method: 'POST' })
  ).json()) as Reply;
  assert.strictEqual(noop.removed, 0, 'the newest version cannot be forgotten');
  assert.strictEqual(noop.history.length, pruned.history.length, 'a refused clean-up changes nothing');
  // Still renders, and still says what it is comparing against. The version it
  // was told to compare against in 9x went in the clean-up, so the memory of it
  // went too and the request falls back — rather than the choice being carried
  // forward as a hash of something no longer on disk.
  assert.ok(
    !pruned.history.some((h) => h.hash === oldest.hash),
    'the version that was being compared against is one of the ones dropped',
  );
  assert.strictEqual(noop.baseline, 'read', 'and still names a baseline it can honour');
  console.log('✓ clean up history to a version', `−${pruned.removed}`, `${pruned.history.length} left`);

  second.server.close();
});
