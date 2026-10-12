import { test } from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert';
import { createServer } from '../../src/hosts/node/server.js';
import { createMarkdown } from '../../src/core/render.js';
import { renderDocument } from '../../src/core/document.js';
import { rootUrl } from '../../src/hosts/node/root.js';
import { renderDiff } from '../../src/core/diff.js';
import { parseFrontMatter, looksLikeFrontMatter } from '../../src/core/front-matter.js';
import { pageJs as appJs, clientFor, pageCss, pageHtml, pageJs, portOf, scratch } from '../support.js';

const tmp = scratch();

// The `---` header block.
// Front matter, which markdown-it has no idea about: left to it, the opening
// `---` is a thematic break and the closing one turns everything above it into
// a setext heading, so the whole header lands as one enormous `<h2>` — and that
// `<h2>` then takes the top row of the contents list. Read as a block instead,
// it is a card of fields, it contributes no heading, and it is one unit to the
// diff like any other block.
test('the `---` header block reads as fields', async () => {
  const hdr = path.join(tmp, 'header.md');
  fs.writeFileSync(
    hdr,
    '---\n' +
      'name: kdoc-conventions\n' +
      'description: "Mandatory KDoc conventions. MUST be applied when writing Kotlin."\n' +
      'allowed-tools: Skill(kotlin-conventions) Skill(ste-style)\n' +
      '---\n\n# KDoc conventions\n\nBody paragraph.\n',
  );
  const fmServer = await createServer({ file: hdr });
  await new Promise<void>((r) => fmServer.server.listen(0, '127.0.0.1', r));
  const fmDoc = await clientFor(`http://127.0.0.1:${portOf(fmServer.server)}`)('/api/doc');
  assert.match(fmDoc.html, /<div class="front-matter" data-line="0">/, 'the header renders as a card');
  assert.match(fmDoc.html, /<dt>allowed-tools<\/dt><dd>Skill\(kotlin-conventions\)/, 'field by field');
  // The one that was actually broken, and the reason this is worth a block rule.
  assert.deepStrictEqual(
    fmDoc.toc.map((h) => h.text),
    ['KDoc conventions'],
    `the header is not a heading: ${JSON.stringify(fmDoc.toc)}`,
  );
  assert.ok(!/<h2/.test(fmDoc.html), 'and nothing of it is set as one');
  // `data-line` on it, like every other top-level block, or switching to the raw
  // view from the top of the document has nowhere to land.
  assert.match(fmDoc.rawHtml, /data-line="0"[^>]*>---/, 'and the raw view still shows it as lines');
  fmServer.server.close();

  const mdFm = createMarkdown();
  const fmHtml = (src) => renderDocument(mdFm, src, null).html;
  // `---`, a line of prose, `---` is valid markdown for an `<h2>` and has to keep
  // meaning that, so a header block is only one when its first line is a field.
  assert.match(fmHtml('---\nSome text\n---\n'), /<h2[^>]*>Some text<\/h2>/, 'a setext heading survives');
  assert.ok(!fmHtml('# T\n\npara\n\n---\n\nmore\n').includes('front-matter'), 'so does a plain rule');
  assert.ok(!fmHtml('---\nname: x\n\n# T\n').includes('front-matter'), 'an unclosed fence is not a header');
  assert.match(fmHtml('---\nname: x\n...\n'), /front-matter/, 'but `...` closes one');
  // Values are shown, never rendered: this is what a tool consuming the file will
  // be handed, and markdown eating a pair of underscores would misreport it.
  assert.match(fmHtml('---\nname: <b>x</b>_y_\n---\n'), /&lt;b&gt;x&lt;\/b&gt;_y_/, 'a value is text');
  // A value edited in place is a word diff inside that one field — the reason the
  // header is a token in the parse rather than something stripped off before it.
  const fmEdit = renderDiff(
    mdFm,
    '---\nname: a\ndescription: old wording\n---\n\n# T\n',
    '---\nname: a\ndescription: new wording\n---\n\n# T\n',
    ['t'],
  );
  assert.strictEqual(fmEdit.stats.modified, 1, 'an edited header is one changed block');
  assert.match(fmEdit.html, /<dd><del class="w-del">old<\/del>/, 'and the wording is marked in its field');
  assert.match(fmEdit.html, /<dt>name<\/dt><dd>a<\/dd>/, 'while the fields that held still are plain');

  // The shapes a header is written in. Not a YAML implementation — nothing here
  // is coerced or resolved — but these are what the format is used for, and a
  // line it cannot make a field of is kept as written rather than dropped.
  const rows = (body) => parseFrontMatter(body).map((r) => [r.key, r.value]);
  assert.deepStrictEqual(rows('tags: [a, "b c"]'), [['tags', { kind: 'list', items: ['a', 'b c'] }]]);
  assert.deepStrictEqual(rows('t:\n- x\n- y'), [['t', { kind: 'list', items: ['x', 'y'] }]], 'a sequence may sit at its key\'s indent');
  assert.deepStrictEqual(rows('t:\n  - x'), [['t', { kind: 'list', items: ['x'] }]], 'or under it');
  assert.deepStrictEqual(
    rows('a:\n  b: 1'),
    [['a', { kind: 'map', rows: [{ key: 'b', value: { kind: 'text', text: '1' } }] }]],
    'a nested mapping stays nested',
  );
  assert.deepStrictEqual(rows('s: |\n  one\n  two'), [['s', { kind: 'text', text: 'one\ntwo', pre: true }]], '`|` keeps its breaks');
  assert.deepStrictEqual(rows('s: >\n  one\n  two'), [['s', { kind: 'text', text: 'one two', pre: false }]], '`>` folds them');
  assert.deepStrictEqual(rows('u: https://x.test/a'), [['u', { kind: 'text', text: 'https://x.test/a' }]], 'the first colon ends the key');
  assert.deepStrictEqual(rows('n: "he said: hi"'), [['n', { kind: 'text', text: 'he said: hi' }]], 'and quotes come off');
  assert.deepStrictEqual(rows('# c\nn: x'), [['n', { kind: 'text', text: 'x' }]], 'comments are structure');
  assert.deepStrictEqual(rows('n: x # why'), [['n', { kind: 'text', text: 'x' }]], 'including trailing ones');
  assert.deepStrictEqual(rows('n: x\nloose line\nk: y').map((r) => r[0]), ['n', null, 'k'], 'an unreadable line is kept');
  assert.ok(!looksLikeFrontMatter(parseFrontMatter('just prose')), 'prose is not a header');
  assert.ok(!looksLikeFrontMatter(parseFrontMatter('')), 'and neither is nothing');

  // A header that names the document is what the bar calls it. `SKILL.md` is the
  // convention the tool reading the file insists on, not what the document is,
  // and three windows of them are three windows with the same title.
  assert.strictEqual(fmDoc.title, 'kdoc-conventions', 'a header names the document');
  assert.strictEqual(
    fmDoc.pathLabel,
    `${fmDoc.dirLabel}/${fmDoc.name}`,
    'and the file is named in the path instead, which is why the path carries it',
  );
  const titleOf = (src) => renderDocument(mdFm, src, null).title;
  assert.strictEqual(titleOf('---\ntitle: T\nname: N\n---\n'), 'T', '`title` wins over `name`');
  assert.strictEqual(titleOf('---\nname: N\ntitle: T\n---\n'), 'T', 'wherever the two sit');
  // The three ways a `title:` is not one. The parse is the gate for the first,
  // which is the point of taking this off the token rather than off the text: a
  // setext heading shows no card, so it must give no title either.
  assert.strictEqual(titleOf('---\ntitle: T\n'), '', 'an unclosed fence is not a header');
  assert.strictEqual(titleOf('---\nSome prose\n---\n'), '', 'nor is a setext heading');
  assert.strictEqual(titleOf('---\nouter:\n  title: T\n---\n'), '', 'a nested title is not it');
  assert.strictEqual(titleOf('---\ntitle: |\n  one\n  two\n---\n'), '', 'nor is a block value');

  // Failing a header, a document with exactly one `# ` is named by it -- a README
  // or a design note, where the heading and the file are about the same thing.
  // The count is the whole of the evidence: several are a document of equal
  // parts, whose first heading is a section that happens to be at the top, and
  // naming the document by it would be picking a chapter's name for the book.
  assert.strictEqual(titleOf('# Only One\n\ntext\n'), 'Only One', 'a lone h1 names the document');
  assert.strictEqual(titleOf('# A\n\n## B\n\n### C\n'), 'A', 'whatever sits under it');
  assert.strictEqual(titleOf('# A\n\ntext\n\n# B\n'), '', 'but two h1s name neither');
  assert.strictEqual(titleOf('## B\n\ntext\n'), '', 'and a document with none is unnamed');
  assert.strictEqual(titleOf('text\n'), '', 'as is one with no headings at all');
  assert.strictEqual(titleOf('# `code` and *em*\n'), 'code and em', 'as text, not as markup');
  assert.strictEqual(titleOf('---\ntitle: T\n---\n\n# H\n'), 'T', 'a header outranks the heading');
  assert.strictEqual(titleOf('---\nd: x\n---\n\n# H\n'), 'H', 'a header that names nothing does not');

  // And the bar uses it. Both halves, because a title with the filename still
  // only in the tooltip would have thrown the name away, and a filename behind
  // both halves of an untitled document's bar would say it twice.
  assert.ok(pageJs.includes('d.title || d.name'), 'the bar prefers the title it was given');
  assert.ok(
    pageJs.includes('d.title ? d.pathLabel : d.dirLabel'),
    'and the path behind it takes the filename on, but only then',
  );

  // The path sits behind the name rather than under it now, so the bar is one
  // line at rest and hovering is what asks "where is this" -- a swap in place,
  // not a second line that is there whether anyone looks at it or not.
  assert.match(pageCss, /\.name-dir \{[^}]*position: absolute/, 'the path overlays the name');
  assert.match(pageCss, /\.name-dir \{[^}]*opacity: 0/, 'and starts out hidden behind it');
  assert.ok(pageCss.includes('.name:hover .name-file'), 'pointing at it fades the name');
  assert.ok(pageCss.includes('.name:hover .name-dir'), 'and brings the path forward in its place');
  // Not when there is no path to bring forward -- nothing open, or a file granted by itself in the
  // web app -- where the swap would empty the bar under the pointer. The mark is worked out from the
  // path in the render that draws it, so nothing can set the one and leave the other as it was.
  assert.match(pageCss, /\.name\.no-path:hover \.name-file \{\s*opacity: 1;/,
    'a box with no path keeps its name');
  assert.match(appJs, /barName = signal\(\{ name: '…', dir: '', path: '' \}\)/,
    'which it has none of to start');
  assert.ok(
    /id="nameBox" class=\{dir \? 'name' : 'name no-path'\}/.test(appJs) &&
      !/\$\('(nameBox|nameDir|name)'\)/.test(appJs),
    'and is marked as it is drawn, by the one component that draws it',
  );
  assert.match(appJs, /mountName\(\$\('nameSlot'\)\);/, 'which is mounted on the bar');

  // `.name` grows to fill the bar's spare width, so a button placed after it in
  // the markup sits wherever that grown box happens to end, not next to the
  // (short, left-aligned) title it hangs off -- empty space the whole way
  // there. Before it, the chevron is at a fixed point by the dot and the gap
  // never opens.
  assert.ok(
    pageHtml.indexOf('id="tabMenuSlot"') > 0 &&
      pageHtml.indexOf('id="tabMenuSlot"') < pageHtml.indexOf('id="nameSlot"'),
    'the all-open-files chevron sits before the name, not adrift after it',
  );

  // The bar's moving parts, the open files and the chevron's menu are Preact components
  // (public/app/ui/), mounted into empty slots that lay out as if the slot were not there; the
  // bar's fixed buttons stay markup, so they are drawn on the first frame, and follow signals.
  assert.match(pageCss, /\.slot \{\s*display: contents;/, 'a slot is no box of its own');
  for (const [slot, mount] of [
    ['tabMenuSlot', /mountTabMenu\(\$\('tabMenuSlot'\), \$\('tabListSlot'\), \{/],
    ['nameSlot', /mountName\(\$\('nameSlot'\)\)/],
    ['changesSlot', /mountChanges\(\$\('changesSlot'\), \{/],
    ['tabListSlot', /mountTabMenu\(\$\('tabMenuSlot'\), \$\('tabListSlot'\)/],
  ] as const) {
    assert.match(pageHtml, new RegExp(`<(span|div) id="${slot}" class="slot"></\\1>`), `${slot} is empty`);
    assert.match(appJs, mount, `and ${slot} is drawn into`);
  }
  for (const id of ['tabMenu', 'nameBox', 'soloTag', 'count', 'ackCount', 'prev', 'next', 'divide',
    'tabList']) {
    assert.ok(!pageHtml.includes(`id="${id}"`), `#${id} is drawn by its component, not the markup`);
    assert.match(appJs, new RegExp(`id="${id}"`), `and is drawn by one`);
  }
  // `.bar` has a backdrop-filter, which makes it the containing block of a fixed child: the menu
  // drawn inside it would be placed against the bar, so its slot is after the header.
  assert.ok(
    pageHtml.indexOf('id="tabListSlot"') > pageHtml.indexOf('</header>'),
    'the chevron\'s menu is drawn outside the bar',
  );
  assert.match(pageCss, /\.bar \{[^}]*backdrop-filter/, 'which is the reason');
  assert.match(appJs, /mountFiles\(\$\('fileList'\), \{ select: selectTab, close: closeTab \}\);/,
    'the sidebar\'s rows are drawn by Files, and pick and close through the host');
  assert.match(appJs, /class=\{on \? 'tab on' : 'tab'\}/, 'with the current file lit');
  assert.match(appJs, /const on = t\.id === state\.docId;/, 'which is the document on screen');
  assert.match(appJs, /onAuxClick=\{\(e\) => e\.button === 1 && actions\.close\(t\.id\)\}/,
    'and the middle button closes a row');
  assert.match(appJs, /const shown = \(\) => !state\.side && state\.tabs\.length > 1;/,
    'the chevron is there with the sidebar shut and more than one file open');
  assert.match(appJs, /effect\(\(\) => \{\s+if \(!shown\(\)\) tabMenuAt\.value = null;/,
    'and its menu is shut with it, so the chevron coming back does not bring it back open');
  assert.match(appJs, /e\.key === 'Escape' && closeTabMenu\(\)/, 'Escape shuts it too');
  assert.ok(
    !/function paintTabs|tabsFor|\$\('(fileList|tabList)'\)\.replaceChildren/.test(appJs),
    'and nothing outside them redraws the rows Preact owns',
  );
  assert.ok(
    /tabMenuAt\.value = left;/.test(appJs) &&
      /function closeTabMenu\(\) \{\s+tabMenuAt\.value = null;\s+\}/.test(appJs) &&
      /document\.addEventListener\('click', \(\) => closeTabMenu\(\)\);/.test(appJs),
    'the menu opens at the chevron and shuts on any click elsewhere',
  );
  // The fixed chrome: one effect each, and nothing else writing the attribute it keeps.
  assert.match(appJs, /bindChrome\(\);/, 'the bar\'s buttons are bound to their signals');
  for (const [what, re] of [
    ['the view', /press\(view, raw, raw \? 'Show rendered \(r\)' : 'Show raw source \(r\)'\)/],
    ['the sidebar', /press\(\$\('side'\), state\.side,/],
    ['the contents', /press\(\$\('tocBtn'\), state\.tocSide,/],
    ['find', /\$\('findBar'\)\.hidden = !findOpen\.value;/],
    ['the dot', /live\.classList\.toggle\('off', why !== null\);/],
    ['the disclosures', /const folded = shut\.value\.includes\(twist\.dataset\.shut\);/],
  ] as const) {
    assert.match(appJs, re, `${what} follows its signal`);
  }
  {
    // main.ts and the viewmodels: everything that is not the effect keeping the attribute.
    const main = ['main.ts', ...fs.readdirSync(rootUrl('public/app/vm/')).map((f) => `vm/${f}`)]
      .map((f) => fs.readFileSync(rootUrl(`public/app/${f}`), 'utf8'))
      .join('\n');
    assert.ok(
      !/\$\('(side|tocBtn|view|find|live)'\)\.(setAttribute|title|classList)/.test(main) &&
        !/\$\('findBar'\)\.hidden =/.test(main) &&
        /function setLive\(on, why\?\) \{\s+liveWhy\.value = on \? null : why;/.test(main),
      'and nothing else sets them',
    );
  }
  assert.match(appJs, /tally\.value = \{[\s\S]*?nav: changeNodes\(\)\.length,/,
    'the count is worked out by paintCount, the reachable changes counted off the page');
  assert.match(appJs, /const v = soloVersion\(state\.data\);\s*return v \? versionName\(v\) : null;/,
    'and the version being read is worked out of the document held');

  // Wiring. The card is a `dl`, and github-markdown-css styles `dl dt` with two
  // type selectors — so every rule here has to carry `.markdown-body` or it is
  // the lighter rule and silently loses, leaving italic labels with 16px of air
  // above each. Exactly the trap this stylesheet keeps falling into.
  assert.ok(pageCss.includes('.markdown-body .front-matter dt'), 'the labels are styled, off two classes');
  assert.ok(pageCss.includes('.markdown-body .front-matter dl'), 'and the pairs are laid out as a grid');
  assert.ok(pageCss.includes('.fm-pre') && pageCss.includes('.fm-raw'), 'and so are the two odd values');
  // Mono, and off `--font-mono` rather than `--doc-font`: a header is machine-facing
  // text, and a custom document font must not drag it around — the same opt-out the
  // tooling labels take.
  assert.match(
    pageCss.slice(pageCss.indexOf('.markdown-body .front-matter {')),
    /^[^}]*font-family:\s*var\(--font-mono\)/,
    'the card is set in mono, independent of the document font',
  );
});

test('a header field that is a list is drawn as one, escaped, and an empty one as nothing', () => {
  const html = createMarkdown().render(
    '---\ntitle: T\ntags: [a, "<b>"]\nnone: []\nsteps:\n  - one\n  - two\n---\n\nBody\n');
  assert.match(html, /<dt>tags<\/dt><dd><ul><li>a<\/li><li>&lt;b&gt;<\/li><\/ul><\/dd>/,
    'a flow sequence is a list, its items text and not markup');
  assert.match(html, /<dt>steps<\/dt><dd><ul><li>one<\/li><li>two<\/li><\/ul><\/dd>/,
    'and so is a block one');
  assert.match(html, /<dt>none<\/dt><dd><\/dd>/,
    'an empty list is an empty value, not an empty <ul>');
});
