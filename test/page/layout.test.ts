import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { rootUrl } from '../../src/hosts/node/root.js';
import { pageCss, pageHead, pageHtml, pageJs } from '../support.js';

// Dragging either column's inner edge. The grip has to exist, has to be styled
// (a 1px border with no cursor is not a handle anyone finds), and both widths
// have to be applied before first paint — restoring them afterwards reflows
// the whole document on every open, which is exactly what the inline script is
// for.
test('both sidebars resize, and leave the document room', async () => {
  assert.match(pageHtml, /id="sideGrip"/, 'the sidebar edge is something to pull');
  assert.match(pageHtml, /id="tocGrip"/, 'and so is the contents edge');
  assert.match(pageHtml, /redline:sidew/, 'their widths are restored before first paint');
  assert.match(pageHtml, /redline:tocw/, 'both of them');
  assert.match(pageJs, /wireGrip\(\$\('sideGrip'\), SIDE_W_KEY, 1\)/, 'the left edge drags right');
  assert.match(pageJs, /wireGrip\(\$\('tocGrip'\), TOC_W_KEY, -1\)/, 'and the right edge drags left');
  assert.match(pageJs, /prefs\.setItem\(key, String\(clampSideW/, 'and both write back');
  assert.match(pageCss, /\.side-grip \{/, 'and the grips are styled');
  assert.ok(pageCss.includes('cursor: col-resize'), 'and say what they do under the pointer');
  // Two columns that are each a reasonable width can still leave no document
  // between them, so the pair is clamped together as well as separately — in the
  // inline script and in app.js both, which is the price of having the widths
  // right on the first frame.
  assert.match(pageJs, /function fitWidths/, 'the pair of widths is fitted to the window');
  assert.match(pageHtml, /innerWidth - 320/, 'by the inline script too, to the same number');
  assert.match(pageJs, /DOC_W_MIN = 320/, 'and app.js agrees with it');
});

// The page's layout is modules of its own (layout/), each wired from main.ts and none importing
// it back. The widths and the height are imported for what they do as they load -- wire their
// grips -- so a dropped import would leave both edges dead with nothing failing to compile.
test('the layout is its own modules, wired from main.ts', async () => {
  {
    const mainTs = fs.readFileSync(rootUrl('public/app/main.ts'), 'utf8');
    const layout = (f) => fs.readFileSync(rootUrl(`public/app/layout/${f}`), 'utf8');
    assert.match(mainTs, /^import '\.\/layout\/widths\.js';$/m,
      'main.ts loads the widths');
    assert.match(mainTs, /^import '\.\/layout\/toc-height\.js';$/m, 'and the height');
    assert.match(mainTs, /^bindKeys\(\{$/m, 'binds the keys');
    assert.match(mainTs, /^bindNative\(\{$/m, 'and the shell');
    assert.ok(mainTs.indexOf('bindNative({') < mainTs.indexOf('await initSettings();'),
      'before it waits on anything, so the first tabs are asked for and heard');
    for (const f of ['widths.ts', 'toc-height.ts', 'keys.ts', 'native.ts', 'fonts.ts']) {
      assert.ok(!/from '\.\.\/main\.js'/.test(layout(f)), `${f} does not import main.ts`);
    }
    assert.match(layout('widths.ts'), /\nfunction fitWidths\(/, 'fitWidths is in widths.ts');
    assert.match(layout('toc-height.ts'), /\nconst tocHMax = /, 'and tocHMax in toc-height.ts');
    assert.match(pageHead, /`fitWidths` in public\/app\/layout\/widths\.ts/,
      'which is where the head script says its mirror is');
    assert.match(pageHead, /`tocHMax` in public\/app\/layout\/toc-height\.ts/, 'both of them');
  }
});

// The viewmodels (vm/) are the page's features, each owning its signals and what it does, and
// they hold together only while every import points down: main.ts wires them, a component in
// ui/ may read them, and none of them reaches up into either. A vm importing main.ts compiles,
// and runs until the first time a value is read before main.ts has defined it.
test('the viewmodels are modules of their own, and import only downwards', async () => {
  {
    const dir = rootUrl('public/app/vm/');
    const vms = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
    const imports = (src) => [...src.matchAll(/^import [^;]*?from '([^']+)';$/gms)].map((m) => m[1]);
    const graph = new Map<string, string[]>();
    for (const f of vms) {
      const specs = imports(fs.readFileSync(new URL(f, dir), 'utf8'));
      for (const spec of specs) {
        assert.ok(
          spec === '@preact/signals' ||
            /^\.\.\/(state|dom|backend|layout\/(native|widths))\.js$/.test(spec) ||
            /^\.\.\/\.\.\/vendor\//.test(spec) ||
            /^\.\/[\w-]+\.js$/.test(spec),
          `vm/${f} imports ${spec}: a viewmodel reaches only the state, the DOM, the backend, ` +
            'the shell, the column widths, the vendored renderer and its siblings',
        );
      }
      const siblings = specs.flatMap((s) => /^\.\/([\w-]+)\.js$/.exec(s)?.[1] ?? []);
      graph.set(f.replace(/\.ts$/, ''), siblings);
    }
    // And among themselves, one way: a cycle of viewmodels is main.ts's tangle over again.
    const done = new Set<string>();
    const visit = (name: string, path: string[]) => {
      assert.ok(!path.includes(name),
        `the viewmodels import in a circle: ${[...path, name].join(' → ')}`);
      if (done.has(name)) return;
      for (const next of graph.get(name) ?? []) visit(next, [...path, name]);
      done.add(name);
    };
    for (const name of graph.keys()) visit(name, []);

    for (const f of fs.readdirSync(rootUrl('public/app/ui/'))) {
      assert.ok(!/from '\.\.\/main\.js'/.test(fs.readFileSync(rootUrl(`public/app/ui/${f}`), 'utf8')),
        `ui/${f} does not import main.ts`);
    }
    // Each is reached. Most wire their own listeners as they load, so one that main.ts no longer
    // loads, by itself or through another viewmodel, is a feature gone with nothing failing to
    // compile.
    const mainTs = fs.readFileSync(rootUrl('public/app/main.ts'), 'utf8');
    const reached = new Set<string>();
    const reach = (name: string) => {
      if (reached.has(name)) return;
      reached.add(name);
      for (const next of graph.get(name) ?? []) reach(next);
    };
    for (const spec of imports(mainTs)) {
      const name = /^\.\/vm\/([\w-]+)\.js$/.exec(spec)?.[1];
      if (name) reach(name);
    }
    for (const f of vms) {
      assert.ok(reached.has(f.replace(/\.ts$/, '')), `main.ts loads vm/${f}`);
    }
    assert.match(mainTs, /^import \{ backend \} from '\.\/backend\.js';$/m,
      'and the backend, which is a module under all of them');
    const vm = (f) => fs.readFileSync(new URL(f, dir), 'utf8');
    assert.match(vm('find.ts'), /\$\('findInput'\)\.addEventListener\('input'/, 'find hears its bar');
    assert.match(vm('peek.ts'), /doc\.addEventListener\('pointerover'/, 'the peek hears the links');
    assert.match(vm('peek.ts'), /pane\.addEventListener\('scroll', hidePeek\);/,
      'and goes when the document scrolls');
    assert.match(vm('contents.ts'), /pane\.addEventListener\('scroll', queueSpy\);/,
      'as Contents follows it, on a listener of its own');
    assert.match(vm('contents.ts'), /doc\.addEventListener\('click', \(e\) => \{\n  const a = \(e\.target as Element\)\.closest\('a\[href\^="#"\]'\);/,
      'and takes the document\'s links to its own headings');
    assert.match(vm('sidebars.ts'), /\$\('side'\)\.addEventListener\('click', \(\) => setSide\(!state\.side\)\);/,
      'the columns are opened from their buttons');
    assert.match(vm('sidebars.ts'), /\$\('tocBtn'\)\.addEventListener\('click', \(\) => setTocSide\(/,
      'both of them');
    assert.match(vm('sidebars.ts'), /querySelectorAll<HTMLElement>\('\.side-twist'\)/,
      'and the disclosures at their tops wired');
    assert.match(mainTs, /^setSide\(state\.side, false\);\nsetTocSide\(state\.tocSide, false\);$/m,
      'which main.ts lays out once from what the head script put on the root');
    assert.match(mainTs, /\n  baseline: chooseBaseline,\n  reveal: [^\n]*\n  check: checkUpdate,\n  go: getUpdate,\n/,
      'Settings is handed the baseline choice and the update check from their viewmodels');
    assert.match(vm('settings.ts'),
      /export function chooseBaseline\(v\) \{[\s\S]{0,300}?state\.baseline = defaultBaseline\(\);\s*load\(\{ keepScroll: true \}\);/,
      'a baseline chosen is the document in front of you compared again');
    assert.match(vm('diagrams.ts'), /doc\.addEventListener\('toggle', \(e\) => drawDiagrams\(/,
      'a diagram is drawn when its "before" opens');
    assert.match(vm('settings.ts'),
      /if \(\(sepia\(\) !== wasSepia \|\| schemeMoved\) && retheme\(\)\) paint\(\);/,
      'and redrawn on a new tint or scheme, only once Mermaid has drawn anything');
    assert.match(vm('settings.ts'), /if \(!applyScheme\(\)\) return;\s*retheme\(\);\s*paint\(\);/,
      'which System moving is too');
    const chromeTs = fs.readFileSync(rootUrl('public/app/ui/chrome.ts'), 'utf8');
    assert.match(chromeTs, /\$\('findCount'\)\.textContent = findCount\.value;/,
      'the find count is drawn from its signal');
    assert.match(chromeTs, /box\.hidden = text === null;/, 'and the notice from its');
    assert.ok(!/\$\('findCount'\)|\$\('notice'\)|\$\('peek'\)/.test(mainTs),
      'and main.ts writes none of them');

    // The changes and their check-offs. acks.ts repaints the count and the ruler after it moves
    // the classes they read, so it imports changes.ts; the other way round would be a circle.
    assert.match(vm('acks.ts'), /^import \{[^}]*\} from '\.\/changes\.js';$/m,
      'check-offs repaint through the changes viewmodel');
    assert.ok(!/from '\.\/acks\.js'/.test(vm('changes.ts')), 'which knows nothing of them');
    assert.match(vm('changes.ts'), /new ResizeObserver\(queueRuler\)\.observe\(doc\);/,
      'the ruler watches the document settle');
    assert.match(vm('changes.ts'), /doc\.addEventListener\('pointerover'/,
      'and hears the pointer over a change');
    assert.match(vm('acks.ts'), /doc\.addEventListener\('click'/, 'a tag in the margin checks off');
    // `hoverNode` is read by acks.ts through the live binding, and only its own module may assign
    // it -- an assignment anywhere else is a TypeError at run time, and a silent one in a listener.
    assert.ok(!/hoverNode =/.test(vm('acks.ts') + vm('core.ts') + mainTs), 'and the hover is changes.ts\'s to set');
    assert.match(vm('core.ts'), /hidePeek\(\);\s*forgetHover\(\);/,
      'which paint has forget the node it is about to replace');
    const moved = 'paintRuler|paintCount|changeNodes|goToChange|keepAnchored|setAck|tapCheck';
    assert.ok(!new RegExp(`^(?:async )?function (?:${moved})\\(`, 'm').test(mainTs),
      'and none of it is in main.ts any more');
    const stateTs = fs.readFileSync(rootUrl('public/app/state.ts'), 'utf8');
    assert.ok(!/export const (?:rulerBands|rulerCurrent|tally) /.test(stateTs),
      'the ruler and the count are the viewmodel\'s signals, not the shared state\'s');
    for (const [f, names] of [['Ruler.tsx', 'rulerBands, rulerCurrent'], ['Changes.tsx', 'tally']]) {
      assert.match(fs.readFileSync(rootUrl(`public/app/ui/${f}`), 'utf8'),
        new RegExp(`^import \\{ ${names} \\} from '\\.\\./vm/changes\\.js';$`, 'm'),
        `ui/${f} reads them from there`);
    }

    // History, the view and Settings. Each redraws the document, and is drawn by it, so they
    // reach the core through vm/document.ts, which vm/core.ts fills as it is imported.
    assert.match(vm('core.ts'), /^bindDocument\(\{ load, adopt, paint, rerender \}\);$/m,
      'the core hands itself to the port');
    assert.ok(!/bindDocument/.test(mainTs), 'and main.ts has nothing to do with it');
    assert.ok(!/from '\.\/core\.js'/.test(vm('history.ts') + vm('view.ts') + vm('settings.ts')),
      'which is what keeps the core out of the modules it draws');
    for (const f of ['history.ts', 'view.ts', 'settings.ts']) {
      assert.match(vm(f), /^import \{[^}]*\} from '\.\/document\.js';$/m, `${f} redraws through it`);
    }
    // One way: History picks a version by turning the marks on, the view stores them as a setting,
    // and Settings hands them back through `shownSettings` rather than calling the view.
    assert.match(vm('history.ts'), /^import \{ setMarks \} from '\.\/view\.js';$/m,
      'History turns the marks on through the view');
    assert.match(vm('view.ts'), /^import \{ writeSettings \} from '\.\/settings\.js';$/m,
      'which stores them as a setting');
    assert.ok(!/from '\.\/(view|history)\.js'/.test(vm('settings.ts')),
      'and Settings knows nothing of either');
    assert.match(vm('view.ts'),
      /effect\(\(\) => \{\s*const s = shownSettings\.value;\s*if \(s\) untracked\(\(\) => setDiff\(s\.marks\)\);/,
      'the view takes the marks from the settings as they are applied');
    assert.ok(!/setDiff/.test(vm('settings.ts')), 'which apply no marks themselves');
    // The repaints that are now signals: the version read alone is worked out, not left, and the
    // History heading keeps to the payload the list is drawn from.
    assert.match(vm('history.ts'), /export const soloName = computed\(\(\) => \{/,
      'the name of the version read alone is computed from what it depends on');
    assert.ok(!/soloName/.test(stateTs), 'and is not shared state for something to forget to set');
    assert.match(fs.readFileSync(rootUrl('public/app/ui/Changes.tsx'), 'utf8'),
      /^import \{ soloName \} from '\.\.\/vm\/history\.js';$/m, 'the bar reads it from there');
    assert.ok(!/paintSolo/.test(pageJs), 'and nothing paints it');
    assert.match(chromeTs, /\$\('histSolo'\)\.hidden = versions\.length < 2 && !state\.solo;/,
      'the switch is drawn from the list and from itself');
    assert.match(chromeTs, /press\(\s*\$\('histSolo'\),\s*state\.solo,/, 'and pressed from its state');
    assert.match(vm('history.ts'),
      /export function paintHistory\(d\) \{[^}]*closeVerMenu\(\);[^}]*shownHistory\.value = d;\s*\}/,
      'what is left of painting History is handing it the payload');
    assert.ok(!/\$\('hist(Count|Clear|Solo)'\)\.(hidden|textContent)|setAttribute/.test(vm('history.ts')),
      'and none of the heading is drawn by hand');
    const historyTsx = fs.readFileSync(rootUrl('public/app/ui/History.tsx'), 'utf8');
    assert.match(historyTsx, /^import \{ isBaseline, versionName, pruneFocus \} from '\.\.\/vm\/history\.js';$/m,
      'the list names a version and asks what is compared against as the bar does');
    const vmMoved = 'setDiff|setMarks|setView|sourceAt|applySettings|applyScheme|markRead|' +
      'openVerMenu|pickVersion|setSolo|initSettings';
    assert.ok(!new RegExp(`^(?:async )?function (?:${vmMoved})\\(`, 'm').test(mainTs),
      'and none of History, the view or Settings is in main.ts any more');
  }
});

// The line between Contents and History is a third thing to drag, the same
// deal turned on its side: a handle in the markup, styling for it, a wired-up
// drag, and the two numbers that keep History from being squeezed to nothing,
// mirrored in the inline script for the same reason the widths are.
test('Contents resizes against History, and defaults to room for a document\'s shape', async () => {
  assert.match(
    pageHtml,
    /role="separator"[^>]*aria-orientation="horizontal"/s,
    'the handle says what it moves',
  );
  assert.match(pageJs, /function wireTocGrip/, 'and dragging it is wired up');
  assert.match(pageJs, /wireTocGrip\(\$\('histGrip'\)\)/, 'to the one handle in the page');
  assert.match(pageJs, /TOC_H_DEFAULT = 180/, 'tall enough to place a document\'s shape by default');
  assert.match(pageJs, /TOC_H_MIN = 90/, 'with a floor under Contents');
  assert.match(pageJs, /HIST_H_MIN = 110/, 'and one under History so the handle cannot swallow it');
  assert.match(
    pageJs,
    /prefs\.setItem\(TOC_H_KEY, String\(clampTocH/,
    'and it writes back',
  );
  assert.match(
    pageCss,
    /#tocSec \{[^}]*height: var\(--toc-h\)/,
    'the height is a variable, not a share',
  );
  assert.match(pageHtml, /redline:toch/, 'restored before first paint, like the widths');
  assert.match(pageHtml, /tocHMax/, 'against the same floor the inline script keeps for History');
  assert.match(
    pageCss,
    /\.shut-toc #histGrip,\s*\.shut-hist #histGrip \{[^}]*display: none/,
    'and the handle goes away with either section it could belong to',
  );
  assert.match(
    pageCss,
    /\.shut-hist:not\(\.shut-toc\) #tocSec/,
    'and Contents takes over when History alone is put away',
  );
});
