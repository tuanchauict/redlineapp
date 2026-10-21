import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { rootUrl } from '../../src/hosts/node/root.js';
import { renderRawDiff } from '../../src/core/diff.js';
import { pageCss, pageHtml, pageJs, pageRun, scratch, serve } from '../support.js';

// The sample, copied, so that nothing a check does can reach the one in the repository.
const tmp = scratch();
const file = path.join(tmp, 'sample.md');
fs.copyFileSync(rootUrl('sample.md'), file);
const { base } = await serve(file);

// The show/hide-changes switch is spread over three files; if one half is
// dropped it silently stops doing anything, which nothing else catches. It has
// no button of its own — the newest row in the history is where it is thrown
// from, so the bar carries no version list and it has to be in the sidebar.
test('show/hide-changes toggle wired end to end', async () => {
  assert.match(pageHtml, /id="histList"/, 'the history list is in the sidebar');
  assert.ok(!pageHtml.includes('id="baseline"'), 'no version dropdown on the bar');
  assert.ok(!pageHtml.includes('id="markRead"'), 'no "Mark read" button on the bar');
  assert.match(pageHtml, /no-diff/, 'marks suppressed before first paint');
  assert.match(pageJs, /classList\.toggle\('no-diff'/, 'the switch drives the class');
  assert.match(pageJs, /v\.current\) return !state\.diff/, 'the newest row shows that state');
  // Moving the read mark is not a button on the row: the row is the button you
  // click to compare against its version, and the two side by side did nearly the
  // same thing from an inch apart. It is in the row's menu instead, beside
  // forgetting, where any row can be marked — an older one meaning "read up to
  // here" — and the keys still say it with the sidebar shut.
  assert.ok(!pageJs.includes('readAction') && !pageCss.includes('.ver-act'), 'no button for it on the row');
  assert.match(pageJs, /markRead\(v\.current \? undefined : v\.hash\)/, "the row's menu marks that row read");
  assert.match(pageJs, /if \(at\) setMarks\(true, \{ redraw: false \}\);/, 'an older one with the marks on');
  assert.match(pageJs, /function markRead/, 'and the key still moves the mark');
  assert.match(pageJs, /key === 'm'/, 'and `m` is what reaches it');
  // Undo went with it. The version the mark came off is still in the history, so
  // the way back is clicking its row; a second, stored way back is a field, an
  // endpoint and a label that flips under the reader.
  for (const gone of ['undoMarkRead', 'canUndoRead', 'readState']) {
    assert.ok(!pageJs.includes(gone), `${gone} is gone from the page`);
  }
  assert.strictEqual(
    (await fetch(base + '/api/undo-mark-read', { method: 'POST' })).status,
    404,
    'and the endpoint with it',
  );
  // A row has to be callable by a name that is the same name tomorrow, so the
  // relative time is the line underneath and never the one you read first.
  assert.match(pageJs, /function clockName/, 'a version nobody named is named by its clock');
  assert.match(pageJs, /<span class="ver-name">\{name\}<\/span>/, 'and that name is the row title');
  assert.ok(pageCss.includes('.ver-name'), 'which the stylesheet sets as one');
  assert.ok(!pageCss.includes('.ver-when'), 'the relative time is no longer it');
  for (const rule of ['.no-diff .chg', '.no-diff .chg-del', '.no-diff .w-del', '.no-diff .raw-del']) {
    assert.ok(pageCss.includes(rule), `stylesheet neutralises ${rule}`);
  }
});

// The contents list and the checked-off marks are each spread over the same
// three files, and each fails quietly if one part goes: a list with no rows, or
// a tag you can click that never changes.
test('contents list + checked changes wired end to end', async () => {
  assert.match(pageHtml, /id="tocList"/, 'the contents list has somewhere to go');
  assert.match(pageJs, /function paintToc/, 'and something to fill it');
  assert.match(pageJs, /function spyToc/, 'and it follows where you are reading');
  // Contents is a component (ui/Contents.tsx): main.ts pairs headings with their nodes, after the
  // document is written, and the list draws whatever that left in `state.toc`.
  assert.match(pageJs, /mountContents\(\$\('tocList'\), \{ go: \(node\) => scrollToNode\(node\) \}\);/,
    'the list is mounted where the page has room for it, and a row lands where a link does');
  assert.match(pageJs, /state\.toc = has \? heads\.map\(\(h\) => \(\{ h, node: headingNode\(h\) \}\)\) : \[\];/,
    'each heading is paired with its node in the document just written');
  assert.match(pageJs, /function Contents\([\s\S]*?if \(!toc \|\| !state\.tocSide\) return null;/,
    'and a shut column, or no document, draws no list at all');
  assert.match(pageJs, /class=\{\['toc', h\.level === top && 'toc-top', i === at && 'on'\]/,
    'the row you are reading under is lit from state.tocAt');
  assert.match(pageJs, /useEffect\(\(\) => \{\s*current\.current\?\.scrollIntoView\(\{ block: 'nearest' \}\);\s*\}, \[toc, at\]\);/,
    'and scrolled into view when that changes, not on every render');
  const spy = pageJs.match(/function spyToc\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(/state\.tocAt = at;/.test(spy) && !/classList|scrollIntoView|\.row\b/.test(spy),
    'the spy only says which heading; it never reaches into the rows Preact owns');
  assert.match(pageCss, /\.toc\.on::before/, 'and says which row that is');
  // Two columns, not three lists in one. Open files is alone on the left, so
  // choosing a file fades once it is chosen; Contents and History share the
  // right column, so a reader following a long document through a review can
  // have the map and the versions up together. All three fold away, each the
  // list its own column stops needing most often.
  assert.strictEqual(
    (pageHtml.match(/class="side-twist"/g) ?? []).length,
    3,
    'Open files, Contents and History are all disclosures',
  );
  assert.match(pageHtml, /redline:shut/, 'and remember themselves before first paint');
  assert.match(pageJs, /prefs\.setItem\(SHUT_KEY/, 'and write that back');
  assert.ok(pageCss.includes('.shut-files #filesSec'), 'the stylesheet folds Open files away');
  assert.ok(pageCss.includes('.shut-toc #tocSec'), 'and Contents too');
  assert.ok(pageCss.includes('.shut-hist #histSec'), 'and History too');
  assert.match(pageHtml, /data-shut="hist"/, 'History shuts under its own key');
  assert.match(pageHtml, /k === "hist"/, 'restored before first paint, like the other two');
  assert.match(pageHtml, /id="tocSide"[^>]*class="side side-r"/, 'the contents are their own column');
  assert.ok(pageCss.includes('.toc-open #tocSide'), 'laid out down the right');
  assert.ok(pageCss.includes('.toc-open main'), 'with the document keeping clear of it');
  assert.match(pageHtml, /redline:toc"/, 'and open or shut before first paint');
  assert.match(pageJs, /function setTocSide/, 'which is a thing the page can change');
  assert.match(pageJs, /id="tocBtn"|\$\('tocBtn'\)/, 'from a switch of its own');
  assert.match(pageHtml, /id="tocBtn"[\s\S]*?id="prefsBtn"/, 'at the end of the bar, like VS Code');
  assert.match(pageHtml, /id="side"[\s\S]*?id="tocBtn"/, 'in the order the columns appear');
  // Each toggle is a picture of the window, so its state is in the picture: the
  // band is the sidebar, filled when that column is open. The button gets no
  // selected background — a filled rounded square around a drawing of a rounded
  // square reads as a smudge, and says "the button is on" rather than "the column
  // is open". Two bands, one per icon, and `.i` sets `fill: none` on the svg, so
  // the fill has to be put back on exactly these.
  assert.strictEqual(
    (pageHtml.match(/class="i-band"/g) ?? []).length,
    2,
    'both panel toggles draw their column as a band',
  );
  assert.ok(pageCss.includes('#side[aria-pressed="true"] .i-band'), 'which fills when it is open');
  assert.ok(pageCss.includes('#tocBtn[aria-pressed="true"] .i-band'), 'each from its own switch');
  assert.doesNotMatch(
    pageCss,
    /#(side|tocBtn)\[aria-pressed="true"\](,|\s*\{)/,
    'and neither button wears a selected fill of its own',
  );
  // The versions sit under Contents, with a draggable seam between them, in
  // both the app and a browser tab — unlike Open files, neither Contents nor
  // History is desktop-only, so the seam carries no `data-shell` of its own.
  assert.match(
    pageHtml,
    /id="histGrip"[^>]*role="separator"/,
    'the seam is a handle, not a bare line',
  );
  assert.match(
    pageCss,
    /\.hist-grip \{[^}]*border-top: 1px solid var\(--line\)/,
    'and, unlike the sidebar edges, visible at rest rather than only on hover',
  );
  // The two used to share one panel behind a tab strip. Nothing of that may be
  // left: a stale `data-panel` rule would stop one of the sections laying out at
  // all, and the symptom is an empty column rather than an error.
  for (const gone of ['.side-seg', '.side-tab', 'data-panel']) {
    assert.ok(!pageCss.includes(gone) && !pageHtml.includes(gone), `${gone} is gone`);
  }
  assert.ok(!/function setPanel|PANEL_KEY/.test(pageJs), 'and so is the switch between them');
  // `redline:panel` may only appear as the migration that retires it: a reader
  // who was on Contents when the update landed gets the new column opened for
  // them, because an update that quietly took away the list you had up reads as
  // a bug.
  assert.match(pageHtml, /prefs\.removeItem\("redline:panel"\)/, 'the old key is retired');
  assert.ok(!pageJs.includes('redline:panel'), 'and nothing else reads it');
  // A document whose only heading is its title has no contents. The column says
  // so rather than closing itself — whether it is open is the reader's standing
  // choice, and the payload that would decide it arrives after first paint.
  assert.match(pageJs, /No headings in this document/, 'an empty contents list says so');

  // Forgetting versions is the only destructive thing in the sidebar, and it does
  // not stop at the row it sits on. It was a picture on the row — a bin, then
  // scissors, then a perforation — and none of them could say "this one and
  // everything older"; a menu item can. Pointing at the item still dims every row
  // that would go. That preview is pure CSS off a sibling combinator, which holds
  // only while the list is rows in one order.
  assert.ok(!pageJs.includes('cutButton') && !pageCss.includes('.ver-cut'), 'the cut icon is gone');
  assert.match(pageHtml, /<div id="verMenu" class="menu" role="menu"/, 'a version has a menu');
  assert.match(pageJs, /<\/span>\s*<More v=\{v\} n=\{n\} actions=\{actions\} \/>\s*<\/button>/,
    'behind a "…" on every row');
  assert.match(
    pageJs,
    /const onContextMenu = \(e: MouseEvent\) => \{\s*e\.preventDefault\(\);[\s\S]*?onContextMenu=\{onContextMenu\}/,
    'and behind a right-click on it, which the browser no longer answers',
  );
  assert.match(
    pageJs,
    /const mark = \(on\) => \(cutFrom\.value = on \? v\.hash : null\);\s*forget\.addEventListener\('pointerenter'/,
    'Forget… says what it would take',
  );
  assert.match(pageJs, /if \(!v\.current\) \{\s*const one = n === 1;\s*const forget = /, 'and is never offered for the version on disk');
  assert.match(pageJs, /closeVerMenu\(\);\s*askPrune\(v\.hash\);/, 'and asks in the row, as the icon did');
  assert.ok(pageCss.includes('.ver.cutting ~ .ver'), 'and the stylesheet dims that far down');
  // `.ver:hover .ver-more` is a class heavier than a bare `.ver-more:hover`, so the
  // hover state has to be qualified or it never applies and the control you are
  // pointing at sits at the same hint as the one you are not.
  assert.ok(pageCss.includes('.ver .ver-more:hover'), 'the "…" lights fully when pointed at');
  assert.match(pageJs, /read\.disabled = !!v\.baseline;/, '"Mark as read" is off on the row already read');
  assert.match(pageCss, /\.menu button:disabled \{\s*background: none;/, 'and does not light up as if it were on');
  // The menu's keys are its own while it has them: `m` would otherwise mark the
  // newest version read from under a menu opened on an older one.
  assert.match(
    pageJs,
    /\$\('verMenu'\)\.addEventListener\('keydown', \(e\) => \{[^}]*e\.stopPropagation\(\);/,
    'the menu keeps its keys',
  );
  assert.match(
    pageJs,
    /function paintHistory\(d\) \{[^}]*closeVerMenu\(\);/,
    'and a repaint closes a menu about a row it is replacing',
  );
  assert.match(pageJs, /<div class="ver ask cutting">/,
    'the confirmation keeps the dim it was reached from');
  // Preact owns the rows, so nothing else may set a class on one: the row reads `held` and
  // `cutting` off the signals the menu and Clear history set, and a class put on by hand would be
  // taken off again by the next render, or left on a node Preact has moved to another version.
  assert.match(pageJs, /menuFor\.value === v\.hash && 'held',\s*cutFrom\.value === v\.hash && 'cutting',/,
    'a row is lit and dimmed from state');
  assert.ok(!/classList\.\w+\([^)]*'(?:held|cutting)'/.test(pageJs),
    'and never by a hand on its classes');
  assert.match(
    pageJs,
    /cutFrom\.value = on \? \(shownHistory\.value\?\.history\?\.\[1\]\?\.hash \?\? null\) : null;/,
    'and Clear history previews the same act the same way',
  );

  assert.match(pageJs, /id="ackCount"/, 'the checked changes are countable');
  assert.match(pageJs, /unack: \(\) => clearAcks\(\),/, 'and the count is the way back to them');
  assert.match(pageJs, /function applyAcks/, 'and shown as checked');
  assert.match(pageJs, /function clearAcks/, 'and can all be brought back');
  assert.match(pageCss, /\.chg-ok \{/, 'and a checked change reads as plain text');
  assert.ok(pageCss.includes('.no-diff .chg-tag'), 'the tag goes with the marks it belongs to');
  // ADDED/CHANGED/REMOVED is the app labelling a block, not the block's own
  // prose, so it reads in the UI font even when the document's is serif or mono.
  assert.match(
    pageCss,
    /\.chg-tag \{[^}]*font-family: var\(--font-sans\)/,
    'the tag ignores --doc-font',
  );
});

// The change ruler is the same three-file shape, and it fails invisibly: no
// element and the marks go nowhere, no `[hidden]` rule and an empty strip
// stays over the scrollbar, no `pointer-events: none` and it swallows every
// grab of the scrollbar it is drawn on top of.
test('the arrows and the count step from where the reader is, one stop per change', async () => {
  assert.match(pageHtml, /id="ruler"/, 'the ruler has somewhere to draw');
  assert.match(pageJs, /function paintRuler/, 'and something to fill it');
  assert.match(pageJs, /new ResizeObserver\(queueRuler\)/, 'and redraws as the document settles');
  assert.match(pageCss, /\.ruler \{[^}]*pointer-events: none/, 'and never takes a click');
  assert.ok(pageCss.includes('.ruler[hidden]'), 'and goes away with the marks it stands for');
  // `main` is the scroll area, so its right edge is where its scrollbar runs.
  // With the contents column up, both have to come in by its width or the ruler
  // is a strip of marks lined up with nothing, behind a list painted over it.
  const inset = /\.toc-open (main|\.ruler) \{\s*right: var\(--toc-w\)/g;
  assert.equal([...pageCss.matchAll(inset)].length, 2, 'the pane and the ruler both end at it');
  for (const rule of ['.ruler-add', '.ruler-mod', '.ruler-del']) {
    assert.ok(pageCss.includes(rule), `stylesheet colours ${rule}`);
  }
  // `--mod` is blue, for "changed" marks, so it cannot also be the `[!WARNING]`
  // alert's colour any more -- that would make a warning read as just another
  // `[!NOTE]`. `--warn` keeps the old amber for that one alert alone.
  assert.match(
    pageCss,
    /\.markdown-alert-warning \{[^}]*var\(--warn\)/,
    'the warning alert keeps its own amber, not the blue "changed" colour',
  );
  assert.ok(
    !/\.markdown-alert-warning[^{]*\{[^}]*var\(--mod\)/.test(pageCss),
    'and does not fall back to --mod',
  );
  // AccentColorText does not reliably resolve in every WebKit, so an opaque
  // AccentColor fill there can leave the default dark text on a bright fill --
  // unreadable rather than merely off-brand. The safe form is the translucent
  // tint `.tab.on`/`.ver.on` already use, which needs no text-colour override.
  assert.ok(
    !/\.menu button:hover \{[^}]*AccentColorText/.test(pageCss),
    'a hovered menu row never pairs AccentColor with AccentColorText',
  );
  assert.match(
    pageCss,
    /\.menu button:hover \{[^}]*color-mix\(in srgb, AccentColor/,
    'it tints with AccentColor instead, the way .tab.on and .ver.on do',
  );
  // `n`/`p` move `state.changeIndex`; the mark for the node it lands on gets its
  // own class rather than relying on the next unrelated repaint to catch up.
  assert.match(
    pageJs,
    /changeNodes\(\)\[state\.changeIndex\]/,
    'paintRuler asks which node is current',
  );
  assert.match(pageJs, /ruler-current/, 'and names the mark that stands for it');
  assert.match(
    pageJs,
    /function goToNode\(node\)[\s\S]*?highlightRulerCurrent\(\)/,
    'and lights the mark right away so it shows at once',
  );
  assert.match(
    pageJs,
    /function goToChange\(step, kind = null\)[\s\S]*?goToNode\(/,
    'the key path lands through the same function a ruler click will',
  );
  assert.match(pageCss, /\.ruler-current \{/, 'and the stylesheet gives that mark its own look');

  // Stepping through the changes, run over fakes the way `applyScheme` is below: the arrows, `n`,
  // `p` and the count on the bar all go through `goToChange`, and what it has to get right is
  // *which* change, which needs only rectangles and a list.
  {
    const vm = await import('node:vm');
    // `export` is taken off what is lifted: the vm runs it as a script, where it is not a word.
    const unexport = (src) => src?.replace(/^\nexport /, '\n');
    const fn = (name) =>
      unexport(pageRun().match(new RegExp(`\\n(?:export )?function ${name}\\(.*?\\n\\}\\n`, 's'))?.[0]);
    // One line ending in `;`, or an arrow function that closes with `};` in the first column.
    const konst = (name) =>
      unexport(pageRun().match(
        new RegExp(`\\n(?:export )?const ${name} = (?:[^\\n]*;|[\\s\\S]*?\\n\\};)\\n`),
      )?.[0]);
    for (const name of ['stepIndex', 'goToChange', 'changeNodes']) {
      assert.ok(fn(name), `vm/changes.ts has ${name}`);
    }
    for (const name of ['changeKind', 'continuesRun', 'LANDING_MS']) {
      assert.ok(konst(name), `vm/changes.ts has ${name}`);
    }

    // The count and the arrows reach it, and the count says which kind it was pressed on.
    assert.match(
      pageJs,
      /id="count"[\s\S]*?onClick=\{\(e\) =>\s+actions\.go\(\s+e\.shiftKey \? -1 : 1,\s+\(e\.target as Element\)\.closest<HTMLElement>\('\[data-kind\]'\)\?\.dataset\.kind,\s+\)/,
      'pressing the count steps through the changes, ⇧ backwards, of the kind pressed on',
    );
    assert.match(pageJs, /mountChanges\(\$\('changesSlot'\), \{[^}]*go: goToChange,/,
      'which is where the arrows go too');
    assert.ok(!/id="count"[^>]*onClick=\{\(\) => \w*[Tt]ocSide/.test(pageJs),
      'and no longer opens the right column');
    for (const kind of ['add', 'mod', 'del']) {
      assert.match(pageJs, new RegExp(`class="c-${kind}" data-kind="${kind}"`), `${kind} knows its kind`);
    }
    assert.match(pageJs, /id="count"[^>]*title="Next change/, 'the count says what it does');

    // `stepIndex` and `goToChange`, over nodes that are only a kind and a rectangle.
    const clock = 100000;
    const view = { top: 50, bottom: 650 };
    const build = (kinds, tops, current = -1) => {
      const nodes = kinds.map((k, i) => ({
        dataset: { chg: k },
        getBoundingClientRect: () => ({ top: tops[i], bottom: tops[i] + 40 }),
      }));
      const landed = [];
      const ctx = vm.createContext({
        state: { changeIndex: current },
        pane: { getBoundingClientRect: () => view },
        performance: { now: () => clock },
        changeNodes: () => nodes,
        goToNode: (n) => landed.push(n),
      });
      vm.runInContext(
        [konst('LANDING_MS'), 'let landedAt = -Infinity;', konst('changeKind'), fn('stepIndex'),
          fn('goToChange'), 'state.diff = true;'].join('\n'),
        ctx,
      );
      const press = (step, kind?) => {
        vm.runInContext(`goToChange(${step}, ${JSON.stringify(kind ?? null)})`, ctx);
        return nodes.indexOf(landed.at(-1));
      };
      return { press, ctx, state: ctx.state };
    };
    const K = ['add', 'mod', 'add', 'del', 'mod'];

    // Nothing chosen yet, at the top of the page: down is the first change, and up wraps to the
    // last one -- it used to land on the one before it.
    let t = build(K, [100, 700, 1300, 1900, 2500]);
    assert.strictEqual(t.press(1), 0, 'down from nothing chosen is the first change');
    t = build(K, [100, 700, 1300, 1900, 2500]);
    assert.strictEqual(t.press(-1), 4, 'and up from nothing chosen is the last, not the one before');

    // Pressed again and again with the page scrolled to wherever the last one put it, it walks the
    // lot and wraps, in order, in both directions.
    t = build(K, [300, 700, 1300, 1900, 2500], 0);
    const walked = [];
    for (let i = 0; i < K.length; i++) {
      walked.push(t.press(1));
      // The scroll lands the change on screen; fake it by moving the window to it.
      const at = t.state.changeIndex;
      view.top = [300, 700, 1300, 1900, 2500][at] - 100;
      view.bottom = view.top + 600;
    }
    assert.deepStrictEqual(walked, [1, 2, 3, 4, 0], 'down visits every change once, then wraps');
    Object.assign(view, { top: 50, bottom: 650 });

    // Scrolled away from the last one by hand: a step is from where the reader is.
    t = build(K, [-900, -400, 700, 1200, 1700], 0);
    assert.strictEqual(t.press(1), 2, 'down goes to the first change below, not back up the page');
    t = build(K, [-900, -400, 700, 1200, 1700], 0);
    assert.strictEqual(t.press(-1), 1, 'and up to the last change above the window');

    // A reload puts the page back to nothing chosen, with the reader well down it: same rule.
    t = build(K, [-3000, -2500, -2000, 400, 900], -1);
    assert.strictEqual(t.press(1), 3, 'after a reload, down starts from the window');

    // Pressed twice before the smooth scroll of the first has got anywhere: the second goes on
    // from the change just chosen, and not from the window, which is still back where it was.
    t = build(K, [-900, 2000, 2600, 3200, 3800], 1);
    vm.runInContext(`landedAt = ${clock - 100}`, t.ctx);
    assert.strictEqual(t.press(1), 2, 'a second press while the scroll is under way goes on');
    // Not so once it is long over and the change is nowhere near: the window rules again.
    t = build(K, [-900, 2000, 2600, 3200, 3800], 1);
    assert.strictEqual(t.press(1), 1, 'and later, with the reader elsewhere, it is from the window');

    // The count presses it by kind: the next *changed* from the window, going round only those.
    t = build(K, [100, 700, 1300, 1900, 2500]);
    assert.strictEqual(t.press(1, 'mod'), 1, 'the first of the kind pressed on');
    vm.runInContext(`landedAt = ${clock}`, t.ctx);
    assert.strictEqual(t.press(1, 'mod'), 4, 'then the next of that kind, skipping the others');
    assert.strictEqual(t.press(1, 'mod'), 1, 'and round again');
    assert.strictEqual(t.press(-1, 'mod'), 4, 'with ⇧ the other way');
    t = build(['add', 'add'], [100, 700]);
    assert.strictEqual(t.press(1, 'mod'), 0, 'a kind this view has none of goes through them all');

    // The raw view marks lines: a rewritten paragraph is a run of them, and a removal is marked by
    // a class rather than a `data-chg`. One stop for each run, removals included.
    const raw = renderRawDiff(
      'intro\n\nalpha one\nalpha two\nalpha three\n\noutro\n',
      'intro\n\nbeta one\nbeta two\nbeta three\n\noutro\n\nadded para\n',
    );
    const lines = [];
    for (const m of raw.matchAll(/<span class="raw-line((?: raw-(?:add|del))?)"[^>]*?(?: data-chg="(\w+)")?>/g)) {
      const classes = ['raw-line', ...m[1].split(' ').filter(Boolean)];
      lines.push({
        classes,
        dataset: m[2] ? { chg: m[2] } : {},
        previousElementSibling: lines.at(-1) ?? null,
        classList: { contains: (c) => classes.includes(c) },
        matches: (sel) => sel === '[data-chg], .raw-del' && (!!m[2] || classes.includes('raw-del')),
      });
    }
    const rawCtx = vm.createContext({
      doc: {
        querySelectorAll: (sel) => {
          assert.strictEqual(sel, '[data-chg], .raw-del', 'one selector for everything marked');
          return lines.filter((l) => l.matches(sel));
        },
      },
    });
    vm.runInContext([konst('changeKind'), konst('continuesRun'), fn('changeNodes')].join('\n'), rawCtx);
    // The two members of a stop that the order is read from; the nodes come out of the vm context.
    interface Stop {
      classList: { contains(c: string): boolean };
      dataset: { chg?: string };
    }
    const stops = vm.runInContext('changeNodes()', rawCtx);
    assert.deepStrictEqual(
      // `from`, so the array is this realm's and not the context's, which never compares equal.
      Array.from(stops, (n: Stop) => (n.classList.contains('raw-del') ? 'del' : n.dataset.chg)),
      ['del', 'add', 'add'],
      'the raw view has a stop per change, removals too, and not one per line',
    );
    assert.ok(lines.filter((l) => l.matches('[data-chg], .raw-del')).length > stops.length,
      'though it marks more lines than that');
  }
});

// The marks are a component (ui/Ruler.tsx). `paintRuler` measures and leaves bands in
// `rulerBands`; `highlightRulerCurrent` only names the current node, so hover and `n`/`p`
// measure nothing again. Marks are keyed by position, so a repaint keeps the elements on screen
// and `.ruler-mark`'s opacity transition has a "before" to fade from.
test('change ruler wired end to end', async () => {
  assert.match(pageJs, /mountRuler\(\$\('ruler'\), \{/, 'the marks are mounted on the ruler');
  assert.match(pageJs, /rulerBands\.value = bands\.map\(/, 'from the bands paintRuler measured');
  assert.match(
    pageJs,
    /function highlightRulerCurrent\(\) \{\s*rulerCurrent\.value =/,
    'the mark is relit without measuring the ruler again',
  );
  assert.match(pageJs, /current && nodes\.includes\(current\) && 'ruler-current'/,
    'a band is current when any node it stands for is');
  assert.match(pageJs, /rulerBands\.value\.map\(\(\{ kind, ok, top, height, nodes \}, i\) => \(\s*<div\s*key=\{i\}/,
    'each mark keeps its element across a repaint');
  assert.ok(!/ruler\.replaceChildren|ruler\.children/.test(pageJs),
    'and nothing reaches past the component into the marks');
  assert.match(pageCss, /\.ruler-mark \{[^}]*transition: opacity/, 'so losing current can fade');
  // The same highlight on hover, not only on `n`/`p` -- delegated, since the
  // marked blocks are replaced whole on every paint and a listener bound to one
  // would go with it.
  assert.match(pageJs, /doc\.addEventListener\('pointerover'/, 'hovering a block is also caught');
  assert.match(pageJs, /doc\.addEventListener\('pointerout'/, 'and leaving it is too');
  assert.match(pageJs, /hoverNode = null/, 'cleared when the document it points into is gone');
  // `c` checks off what the pointer is on -- the block the ruler shows as current --
  // before it falls back to the last change `n`/`p` landed on.
  assert.match(
    pageJs,
    /function changeUnderCursor\(\) \{[^}]*hoverNode\?\.isConnected[^}]*return hoverNode/,
    '`c` acts on the hovered change first',
  );
  // A mark is also something to point at, not only something to read: a click
  // lands on the change it stands for, and hovering it tints the block(s) back,
  // the reverse of the doc-to-ruler hover above.
  assert.match(pageJs, /onClick=\{\(\) => actions\.go\(nodes\[0\]\)\}/, 'a mark can be clicked');
  assert.match(
    pageJs,
    /mountRuler\(\$\('ruler'\), \{\s*go: \(node\) => \{[\s\S]*?goToNode\(node\);/,
    'and lands the same way n\\/p do',
  );
  assert.match(pageJs, /onPointerEnter=\{\(\) => actions\.hover\(nodes\)\}/,
    'and hovering one is caught too');
  assert.match(pageJs, /onPointerLeave=\{\(\) => actions\.hover\(null\)\}/, 'and leaving it is too');
  assert.match(pageJs, /hover: hoverMarks,/, 'which tint and untint the blocks it stands for');
  assert.match(
    pageJs,
    /classList\.add\('chg-hot'\)/,
    'hovering a mark tints the blocks it stands for',
  );
  assert.match(
    pageCss,
    /\.chg:hover,\s*\n\s*\.chg-hot \{/,
    'the stylesheet folds that class into the block-hover look',
  );
  assert.match(
    pageCss,
    /\.chg:hover > \.chg-tag,\s*\n\s*\.chg-hot > \.chg-tag,/,
    'including the label the hover brings up',
  );
  assert.match(
    pageCss,
    /\.ruler-mark \{[^}]*pointer-events: auto/,
    'the mark alone takes the click',
  );
  assert.match(pageCss, /\.ruler-mark \{[^}]*cursor: pointer/, 'and admits it');
  // The hit box and the colour are two different rules on purpose: a hover area
  // generous enough to land a click on would be a thick bar on the eye if its
  // own background were the mark's colour, so the colour is a narrower
  // pseudo-element centred inside it instead.
  assert.match(pageCss, /\.ruler-mark::after \{/, 'the visible stripe is its own element');
  assert.match(
    pageCss,
    /\.ruler-current::after \{[^}]*width:/,
    'the current mark widens the stripe, not the hit box behind it',
  );
  // The platform scrollbar `main` otherwise leaves alone grows on hover and
  // while scrolling, wide enough in that state to swallow several ruler marks
  // at once -- pinning its width is what keeps the two from fighting over the
  // same track.
  assert.match(pageCss, /main::-webkit-scrollbar \{/, 'the scrollbar is pinned to a fixed width');
  assert.match(
    pageCss,
    /main \{[^}]*scrollbar-width: thin/,
    'and asked the same of the one engine without it',
  );
});

// A checked change keeps its place on the ruler but is drawn differently: solid when there is
// still something to check, a zebra once there is not. The bands already carried `ok` (a merged
// band is never half checked, see `paintRuler`), so what has to hold is that it reaches the mark
// as a class and that the class changes the stripe's pattern and not only its shade.
test('the ruler draws a checked change as a zebra and an unchecked one solid', () => {
  assert.match(pageJs, /ok && 'ruler-ok'/, 'a checked band is given the class');
  assert.match(pageJs, /last\.ok === ok/, 'and a band merges only with one in the same state');

  const solid = pageCss.match(/\.ruler-mark::after \{([^}]*)\}/);
  assert.ok(solid, 'the stripe has a rule');
  assert.match(solid[1], /background: var\(--mark\)/, 'solid in the change\'s colour by default');

  const zebra = pageCss.match(/\.ruler-ok::after \{([^}]*)\}/);
  assert.ok(zebra, 'a checked stripe has a rule of its own');
  assert.match(zebra[1], /repeating-linear-gradient\(\s*135deg,/, 'which stripes it, leaning like //');
  assert.match(zebra[1], /var\(--mark\)/, 'in the same colour, so the kind still reads');
  assert.match(zebra[1], /transparent/, 'with gaps between');
  // Same specificity as the solid rule, so source order is what decides which one wins.
  assert.ok(pageCss.indexOf('.ruler-ok::after {') > pageCss.indexOf('.ruler-mark::after {'),
    'and it comes after the solid one');
  // The pattern is the signal; a fade deep enough to hide it would leave only a shade to go by.
  const fade = pageCss.match(/\.ruler-ok \{[^}]*opacity: ([\d.]+)/);
  assert.ok(fade && Number(fade[1]) >= 0.5, 'and the fade leaves the stripes visible');
});
