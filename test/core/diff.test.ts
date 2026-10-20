import { test } from 'node:test';
import assert from 'node:assert';
import { createMarkdown } from '../../src/core/render.js';
import { renderDocument } from '../../src/core/document.js';
import { renderDiff } from '../../src/core/diff.js';
import { pageJs as appJs, mdPage, unbalanced } from '../support.js';

const mdDiff = createMarkdown();
const diffOf = (a, b) => renderDiff(mdDiff, a, b).html;

test('word-level diff inside changed blocks', async () => {
  const inlineCases = [
    {
      name: 'words inside emphasis',
      before: 'The **quick brown fox jumps** over the lazy dog.',
      after: 'The **slow** brown wolf leaps over the lazy dog.',
    },
    { name: 'link text and href', before: 'See [the docs](https://a.example) now.', after: 'See [the guide](https://b.example) now.' },
    { name: 'table cell', before: '| a | b |\n| - | - |\n| one | two |', after: '| a | b |\n| - | - |\n| one | three |' },
    { name: 'list item text', before: '- alpha item\n- beta item', after: '- alpha item\n- gamma item' },
    { name: 'heading', before: '# Old Title Here', after: '# New Title Here' },
    { name: 'inline code', before: 'Call `doThing(1)` to start.', after: 'Call `doThing(2)` to start.' },
    { name: 'code fence body', before: '```js\nconst a = 1;\n```', after: '```js\nconst a = 2;\n```' },
  ];
  for (const c of inlineCases) {
    const html = diffOf(c.before, c.after);
    assert.match(html, /chg chg-mod chg-inline/, `${c.name}: diffed inline`);
    assert.match(html, /class="w-(add|del)"/, `${c.name}: something marked`);
    assert.strictEqual(unbalanced(html), null, `${c.name}: ${unbalanced(html)}`);
  }

  // A mark must never straddle a tag it does not own.
  const emph = diffOf('The **quick brown fox jumps** over the lazy dog.', 'The **slow** brown wolf leaps over the lazy dog.');
  assert.ok(!/<(ins|del) class="w-[^"]*">[^<]*<\/strong>/.test(emph), 'mark closed before </strong>');
  assert.match(emph, /<strong>[\s\S]*?<\/strong>/, 'emphasis element survived');

  // Fallback: a removal that spans block structure has no valid place inline.
  const dropped = diffOf('- alpha item\n- beta item\n- gamma item', '- alpha item\n- gamma item');
  assert.ok(!dropped.includes('chg-inline'), 'structural removal not inlined');
  assert.match(dropped, /chg-before[\s\S]*beta item/, 'structural removal falls back to the before disclosure');

  // Fallback: rewritten past recognition reads better as two versions.
  const rewritten = diffOf(
    'The deployment pipeline runs on every push to main.',
    'Costs are tracked per team and billed monthly in arrears, yes.',
  );
  assert.ok(!rewritten.includes('w-add'), 'wholesale rewrite not word-diffed');

  // Bridging: an edit either side of one unchanged word is one phrase, not two.
  const bridged = diffOf('the red car and blue bike', 'the green car and yellow bike');
  assert.strictEqual((bridged.match(/class="w-add"/g) ?? []).length, 1, 'nearby edits merged into one mark');
});

// markdown-it ends `<details><summary>…` at the blank line before the markdown inside it, so a split
// by tokens alone makes the opening tag, the table and `</details>` three blocks -- and a change
// mark's `</div>` around the first closes the `<details>`, leaving the table outside it.
test('an HTML element left open is one block with what it holds', () => {
  const doc = (summary, cell) =>
    `# T\n\n<details>\n<summary>${summary}</summary>\n\n| a | b |\n|---|---|\n| ${cell} | 2 |\n\n` +
    '</details>\n\nend\n';
  const cases = [
    { name: 'summary and cell edited', before: doc('Click', '1'), after: doc('Click me', '3') },
    { name: 'summary edited', before: doc('Click', '1'), after: doc('Click me', '1') },
    { name: 'cell edited', before: doc('Click', '1'), after: doc('Click', '3') },
    { name: 'added', before: '# T\n\nend\n', after: doc('Click', '1') },
    { name: 'removed', before: doc('Click', '1'), after: '# T\n\nend\n' },
  ];
  for (const c of cases) {
    const html = diffOf(c.before, c.after);
    assert.strictEqual(unbalanced(html), null, `${c.name}: ${unbalanced(html)}`);
    assert.match(html, /<details>[\s\S]*<table[\s\S]*<\/table>\s*<\/details>/,
      `${c.name}: the table is inside the disclosure`);
    assert.strictEqual((html.match(/data-chg=/g) ?? []).length, 1, `${c.name}: one change, not three`);
  }

  // Balanced on its own, it is still only itself, and an unrelated edit after it marks only that.
  const closed = '<details><summary>x</summary>body</details>\n\n';
  const html = diffOf(closed + 'old words here', closed + 'new words here');
  assert.ok(!/<div class="chg[^>]*>(?:<button[\s\S]*?<\/button>)?<details>/.test(html), 'a closed element stands alone');
});

// The page draws a diagram from the text of its source node, so a word diff inside one would hand
// the renderer the old words and the new together. An edited diagram is the whole diagram, new
// beside the old behind "before" -- whatever kind it is, and wherever in the document it sits.
test('an edited diagram is shown whole, never word-diffed', () => {
  const fence = (lang, body, indent = '') =>
    ['```' + lang, ...body.split('\n'), '```'].map((l) => indent + l).join('\n');
  const mermaid = { a: 'graph TD\n  A-->B\n  B-->C', b: 'graph TD\n  A-->B\n  B-->D' };
  const puml = (word) => `@startuml\nA -> B : hello\nB -> C : ${word}\n@enduml`;
  const plantuml = { a: puml('go'), b: puml('stop') };
  const kinds = [
    { lang: 'mermaid', node: 'pre class="mermaid"', ...mermaid },
    { lang: 'plantuml', node: 'pre class="plantuml"', ...plantuml },
    { lang: 'puml', node: 'pre class="plantuml"', ...plantuml },
  ];
  for (const k of kinds) {
    // Top level, and inside a list item, where the block that changed is the list.
    const shapes = [
      { where: 'top level', wrap: (code) => `${fence(k.lang, code)}\n` },
      { where: 'in a list item', wrap: (code) => `- item\n\n${fence(k.lang, code, '  ')}\n` },
    ];
    for (const s of shapes) {
      const name = `${k.lang} ${s.where}`;
      const html = diffOf(s.wrap(k.a), s.wrap(k.b));
      assert.ok(!html.includes('chg-inline'), `${name}: not word-diffed`);
      assert.ok(!/<(?:ins|del) class="w-/.test(html), `${name}: no mark inside the source`);
      assert.strictEqual(unbalanced(html), null, `${name}: ${unbalanced(html)}`);
      const [now, before] = html.split('<details class="chg-before">');
      assert.ok(before, `${name}: the old diagram is behind "before"`);
      // Each side holds one source, whole: the new one shows, the old one is behind the disclosure.
      const source = (part) =>
        [...part.matchAll(new RegExp(`<${k.node}>([\\s\\S]*?)</pre>`, 'g'))].map((m) =>
          m[1].replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
        );
      assert.deepStrictEqual(source(now), [k.b + '\n'], `${name}: the new source, whole`);
      assert.deepStrictEqual(source(before), [k.a + '\n'], `${name}: the old source, whole`);
    }
  }
});

// The page carries an opened "before" across a rebuild by the key of the block it is in (`paint`
// in public/app.js), so the disclosure has to sit directly in a keyed block, and the key has to be
// the same each time the same change is rendered -- from the same text, with unrelated text moving
// around it.
test('a rebuild keeps what the reader opened', async (t) => {
  await t.test('a "before" belongs to a keyed block, and the key survives a rebuild', async () => {
    const keyed = (html) => [...html.matchAll(/data-key="([^"]+)"[^>]*>(?:(?!<div class="chg)[\s\S])*?<details class="chg-before">/g)]
      .map((m) => m[1]);
    const before = '- alpha item\n- beta item\n- gamma item';
    const after = '- alpha item\n- gamma item';
    const first = diffOf(before, after);
    assert.strictEqual(keyed(first).length, 1, 'a "before" is inside a block that has a key');
    assert.deepStrictEqual(keyed(diffOf(before, after)), keyed(first), 'and the same change gets the same key again');
    // The new paragraph goes after the list: a run of removed blocks is paired with the added ones
    // by position, so one added in front would push the list off its partner and it would stop
    // being a "before" at all, which is a different thing to ask about.
    assert.deepStrictEqual(
      keyed(diffOf(`# Moved\n\nIntro.\n\n${before}`, `# Moved\n\nIntro.\n\n${after}\n\nA new closing paragraph.`)),
      keyed(first),
      'even with text added and unchanged text around it',
    );
  });

  // And that the page does what that is for. Nothing here can run `paint`, so this is the
  // wiring: that a reload of the document on screen can leave the article standing, that
  // nothing else is allowed to, and that a rebuild puts an opened "before" back.
  await t.test('the page leaves an unchanged article alone on a reload of the same markup', async () => {
    assert.match(appJs, /paint\(\{ reuse: keepScroll \}\);/, 'a reload of the open document asks to reuse the article');
    assert.strictEqual((appJs.match(/paint\(\{ reuse:/g) ?? []).length, 1,
      'and it is the only caller that does: a theme or tint change has to rebuild the diagrams');
    assert.match(appJs, /const stay = reuse && painted\.id === state\.docId && painted\.source === source;/,
      'it stays only for the same document and the same markup');
    assert.match(appJs, /if \(!stay\) \{[\s\S]*?doc\.innerHTML = sanitizeDocument\(source\);[\s\S]*?painted = \{ id: state\.docId, source \};/,
      'otherwise the article is rebuilt, and what it was built from is remembered');
    assert.match(appJs.match(/function closeDocument\([\s\S]*?\n\}/)?.[0] ?? '', /painted = \{ id: '', source: null \};/,
      'and closing the document forgets it, so the same file opened again is not taken for what is gone');
    assert.match(appJs, /if \(!stay && findOpen\.value\)/,
      'a find is redone only when the nodes it marked were replaced');
  });

  // What a rebuild does to what the reader did, which is the other half: it is read off the old
  // nodes, put on the new ones by name, and the names are the text's own.
  await t.test('a rebuild puts back what the reader did to a disclosure, by name', async () => {
    const paintFn = appJs.match(/function paint\([\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(paintFn, /const saved = painted\.id === state\.docId \? readKept\(\) : null;/,
      'a rebuild reads what was done to the article on screen, and only to this document\'s');
    assert.match(paintFn, /readKept\(\)[\s\S]*?doc\.innerHTML = sanitizeDocument\(source\);[\s\S]*?if \(saved\?\.size\) writeKept\(saved\);/,
      'before the nodes are replaced, and put back onto the new ones straight after');
    const keptDecl = appJs.match(/const kept = \[[\s\S]*?\n\];/)?.[0] ?? '';
    assert.match(keptDecl, /name: 'details',\s+selector: 'details',/, 'a disclosure is a kind of state kept');
    assert.match(keptDecl, /el\.closest\('\.chg\[data-key\]'\)\?\.dataset\.key/,
      'a "before" is named by its change, the key a check-off already uses');
    assert.match(keptDecl, /el\.querySelector\(':scope > summary'\)/,
      'and an author\'s disclosure by its summary, not by where it is');
    assert.match(keptDecl, /read: \(el\) => el\.open,[\s\S]*?el\.open = open;/, 'and both ways of the state are a property of the element');
    assert.match(appJs, /const nth = seen\.get\(base\) \?\? 0;[\s\S]*?`\$\{kind\.name\}:\$\{base\}#\$\{nth\}`/,
      'elements that say the same are told apart by their order, and kinds cannot be mistaken for each other');
    assert.ok(!/\.chg-before\[open\]|openBefores/.test(appJs), 'nothing reads one kind of disclosure by itself any more');

    // The renderer lets an author's `<details>` through, summary and all, which is what the name is
    // taken from.
    const authored = renderDocument(
      mdPage,
      '# T\n\n<details>\n<summary>FAQ</summary>\n\nAnswer.\n\n</details>\n',
      null,
    ).html;
    assert.match(authored, /<details>\s*<summary>FAQ<\/summary>/, 'an author\'s disclosure arrives with its summary');
  });
});
