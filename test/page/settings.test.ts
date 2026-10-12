import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { rootUrl } from '../../src/hosts/node/root.js';
import { createRequire } from 'node:module';
import { keyToScheme } from '../../scripts/markdown-css.mjs';
import { pageCss, pageHead, pageHtml, pageJs, pageRun, scratch, serve, settingsTsx, type Reply } from '../support.js';

// The sample, copied, so that nothing a check does can reach the one in the repository.
const tmp = scratch();
const file = path.join(tmp, 'sample.md');
fs.copyFileSync(rootUrl('sample.md'), file);
const { base } = await serve(file);

// Settings. The two controls nobody could work — a slider for a size in
// whole pixels, and a text field you had to spell a font's name into — are
// gone, and what replaced them has to be reachable: a stepper is two buttons
// and a readout, and the typeface popup is empty markup until the script
// fills it from the fonts this machine actually resolves.
test('the settings sheet is a component, opened by a signal and wired to writeSettings', async () => {
  assert.ok(![pageHtml, settingsTsx].some((src) => src.includes('type="range"')),
    'no slider for a size counted in whole pixels');
  assert.ok(!settingsTsx.includes('id="setFontName"'), 'and no font to spell by hand');
  assert.match(settingsTsx, /id="setSizeDown"[\s\S]*?disabled=\{s\.textSize <= SIZE_MIN\}/,
    'text size steps down, as far as the floor');
  assert.match(settingsTsx, /id="setSizeUp"[\s\S]*?disabled=\{s\.textSize >= SIZE_MAX\}/,
    'and up, as far as the ceiling');
  assert.match(pageJs, /const stepSize =/, 'and the step is bounded, not free');
  assert.match(pageJs, /listFonts/, 'the typeface popup is filled from this machine');
  assert.match(pageJs, /function fontInstalled/, 'with a measured catalogue behind it');
  assert.match(pageCss, /\.seg input:checked \+ span \{/, 'a segmented control shows its answer');
  assert.match(pageCss, /\.switch input:checked \+ \.track \{/, 'and an on/off setting is a switch');
  // A popup left to itself is drawn by the system — a grey slab with a blue
  // arrow, next to controls that are neither. The chevron has to come back with
  // it, and it can only hang off the wrapper.
  assert.match(pageCss, /\.select \{[^}]*appearance: none/, 'the popup is not the system one');
  assert.match(pageCss, /\.popup::before,/, 'so it draws its own chevron');
  assert.match(settingsTsx, /class="popup"/, 'on the wrapper that can hold one');
  // The sheet is a component, shut until asked: a slot in the page, the dialog drawn into it, and
  // one signal between the ways in (⌘,, the button, the menu) and showModal.
  {
    const mainTs = fs.readFileSync(rootUrl('public/app/main.ts'), 'utf8');
    assert.match(pageHtml, /<span id="prefsSlot" class="slot"><\/span>/, 'Settings has a slot');
    assert.ok(!/<dialog/.test(pageHtml), 'and no dialog of its own in the page');
    assert.match(settingsTsx, /<dialog id="prefs" class="sheet" ref=\{sheet\} onClose=\{\(\) => \(prefsOpen\.value = null\)\}>/,
      'the dialog tells the signal when it shuts, by Escape or by Done');
    assert.match(settingsTsx, /if \(!dialog\.open\) dialog\.showModal\(\);/, 'and is shown modal');
    const settingsTs = fs.readFileSync(rootUrl('public/app/vm/settings.ts'), 'utf8');
    assert.match(settingsTs,
      /function openPrefs\(\) \{\s*if \(prefsOpen\.value === null\) prefsOpen\.value = '';/,
      'opening it is the signal');
    assert.match(settingsTs, /\$\('prefsBtn'\)\.addEventListener\('click', openPrefs\);/, 'from the bar');
    assert.match(settingsTs, /native\?\.onOpenSettings\(\(\) => openPrefs\(\)\);/, 'and from the menu');
    const keysTs = fs.readFileSync(rootUrl('public/app/layout/keys.ts'), 'utf8');
    assert.match(keysTs, /e\.key === ',' && \(e\.metaKey \|\| e\.ctrlKey\)\) \{\s*e\.preventDefault\(\);\s*openPrefs\(\);/,
      'and from ⌘, in a tab');
    assert.match(mainTs, /bindKeys\(\{[^}]*\n  openPrefs,\n/, 'which main.ts hands the keys');
    assert.ok(!/\$<HTMLDialogElement>\('prefs'\)|\$\('set[A-Z]|\$\('update/.test(mainTs + settingsTs),
      'and neither main.ts nor the viewmodel reaches into the sheet for anything');
    // What the sheet shows is what was applied: written once, at the end of applySettings.
    assert.match(settingsTs,
      /shownSettings\.value = settings;\s*docMeasure\.value = getComputedStyle\(root\)/,
      'the sheet sees each setting as it is applied, and the measure the width came to');
    const fontsTs = fs.readFileSync(rootUrl('public/app/layout/fonts.ts'), 'utf8');
    assert.match(fontsTs, /fontGroups\.value = listed;/, "the machine's fonts go to the popup");
    assert.match(mainTs, /await initSettings\(\);\s*(?:\/\/[^\n]*\n\s*)*listFonts\(backend, \(\) => settings\);/,
      'asked for once the settings are in, and reading them as they are when the fonts come');
    assert.match(settingsTsx, /fontGroups\.value\.map\(/, 'which draws them');
    for (const [control, write] of [
      ['setAppearance', /actions\.write\(\{ appearance: v \}\)/],
      ['setReopen', /actions\.write\(\{ reopenLast: v === '1' \}\)/],
      ['setFinder', /actions\.write\(\{ finderOpensIn: v \}\)/],
      ['setWidth', /actions\.write\(\{ width: v \}\)/],
      ['setMarks', /actions\.write\(\{ marks: \(e\.target as HTMLInputElement\)\.checked \}\)/],
      ['setBaseline', /pick=\{actions\.baseline\}/],
    ] as [string, RegExp][]) {
      const from = settingsTsx.indexOf(`id="${control}"`);
      assert.ok(from > 0 && write.test(settingsTsx.slice(from, from + 900)), `${control} is wired`);
    }
    assert.match(mainTs, /mountSettings\(\$\('prefsSlot'\), [^\n]*\n  write: writeSettings,\n  step: stepSize,/,
      'and writes through writeSettings, which applies, stores and tells the shell');
  }
});

// The specimen is only honest if it reads the same two variables the document
// does; drawn from settings in script instead, it drifts the first time one
// of them is set from somewhere else.
test('settings controls wired end to end', async () => {
  assert.match(pageCss, /\.sample \{[^}]*var\(--doc-font\)/, 'the specimen is the document type');
  assert.match(pageCss, /\.sample \{[^}]*var\(--doc-size\)/, 'at the document size');
  // A custom typeface stops at the prose. The label on a changed block sits
  // inside the document but is the app talking, and `font: inherit` on a button
  // would hand it whatever the document happens to be set in.
  assert.match(
    pageCss,
    /button,\s*\.select \{[^}]*font-family: var\(--font-sans\)/,
    'the tooling in the document keeps the system font',
  );
  // And the names in it come from the OS, because nothing in a browser will say:
  // a catalogue written by hand lists faces this machine has never had and
  // misses the one it is set in. An empty list is a fair answer off macOS.
  const { fonts } = (await (await fetch(base + '/api/fonts')).json()) as Reply;
  assert.ok(Array.isArray(fonts), '/api/fonts answers with a list of families');
  if (process.platform === 'darwin') {
    assert.ok(fonts.length > 20, 'and on a Mac it is the ones installed here');
    assert.ok(fonts.includes('Helvetica'), 'named the way a font menu names them');
    assert.ok(!fonts.some((f) => /wingding|emoji/i.test(f)), 'minus what is not for reading');
  }
});

// Sepia is the one appearance in four places at once, and each is a way for it
// to half work: a radio nobody's code reads, a tint applied a frame late (a
// white flash on every open), a window the shell leaves following a dark
// system (a dark bar round a cream page), or a cream that reaches paper.
test('sepia wired through page, head script, stylesheet and shell', async () => {
  const prefsRs = fs.readFileSync(rootUrl('shell/src/prefs.rs'), 'utf8');
  assert.match(settingsTsx, /\{ value: 'sepia', text: 'Sepia' \}/, 'sepia can be chosen');
  assert.match(
    pageHtml.slice(0, pageHtml.indexOf('</head>')),
    /s\.appearance === "sepia"\) document\.documentElement\.dataset\.tint = "sepia"/,
    'and is tinted before first paint',
  );
  assert.match(pageJs, /if \(settings\.appearance === 'sepia'\) root\.dataset\.tint = 'sepia'/,
    'and again whenever the setting changes');
  assert.match(pageJs, /else delete root\.dataset\.tint/, 'and untinted when it changes away');
  assert.match(prefsRs, /"light" \| "sepia" => Some\(tauri::Theme::Light\)/,
    'the shell pins a sepia window light');
  assert.match(pageCss, /@media screen \{\s*:root\[data-tint="sepia"\] \{/,
    'the palette is drawn on screen only, so print stays white');
  assert.match(pageCss, /:root\[data-tint="sepia"\] \.markdown-body \{[^}]*--bgColor-muted/,
    "and github-markdown-css's own palette is tinted with it");
  assert.match(pageJs, /sepia\(\)\s*\?[\s\S]{0,200}theme: 'base'/, 'diagrams are drawn in it too');
});

// Light and dark are the page's to draw, from the setting, as `data-scheme` on <html>: a browser
// tab cannot be told it is dark the way the shell tells a window, so anything left to
// `prefers-color-scheme` would draw a tab set to Dark light on a light system. Each half of that
// is a way for it to half work -- a head script and `applyScheme` that disagree (the wrong scheme
// for one frame, on every open), a stylesheet still keyed to the media query, a highlight.js sheet
// left on, a dark palette that reaches paper, or diagrams drawn for the system's scheme.
test('the scheme is the page\'s: head script and applyScheme agree, every sheet reads it', async () => {
  const vm = await import('node:vm');
  const DARK_QUERY = '(prefers-color-scheme: dark)';
  const headScript = pageHead.match(/<script>([\s\S]*?)<\/script>/)[1];
  const fakeLinks = () => ({ hljsLight: { media: '' }, hljsDark: { media: '' } });
  const seen = (html, links) => ({
    scheme: html.dataset.scheme,
    tint: html.dataset.tint,
    light: links.hljsLight.media,
    dark: links.hljsDark.media,
  });

  // The head script as it runs before first paint, over a fake of what it touches.
  const runHead = (appearance, systemDark) => {
    const store = new Map();
    if (appearance) store.set('redline:settings', JSON.stringify({ appearance }));
    const links = fakeLinks();
    const html = {
      dataset: {},
      style: { setProperty() {} },
      classList: { add() {}, contains: () => false },
      matches: () => false,
    };
    vm.runInNewContext(headScript, {
      __REDLINE_PREFS: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
      },
      location: { search: '' },
      URLSearchParams,
      innerWidth: 1200,
      innerHeight: 800,
      matchMedia: (q) => {
        assert.strictEqual(q, DARK_QUERY, 'the head script asks the one query');
        return { matches: systemDark };
      },
      document: { documentElement: html, getElementById: (id) => links[id] },
    });
    return seen(html, links);
  };

  // `applyScheme` out of app.js, over the same fakes.
  const applySchemeSrc = pageRun()
    .match(/\n(?:export )?function applyScheme\(\) \{[\s\S]*?\n\}\n/)?.[0]
    .replace(/^\nexport /, '\n');
  assert.ok(applySchemeSrc, 'vm/settings.ts has applyScheme');
  assert.ok(pageJs.includes(`const darkMode = matchMedia('${DARK_QUERY}');`),
    'and reads System off the same query the head script does');
  const appScheme = (appearance, systemDark) => {
    const links = fakeLinks();
    const html = { dataset: {} };
    const ctx = vm.createContext({
      settings: { appearance },
      darkMode: { matches: systemDark },
      $: (id) => links[id],
      document: { documentElement: html },
    });
    vm.runInContext(applySchemeSrc, ctx);
    const moved = vm.runInContext('applyScheme()', ctx);
    return { ...seen(html, links), moved, again: vm.runInContext('applyScheme()', ctx), ctx };
  };

  const ON_DARK = { scheme: 'dark', light: 'print', dark: 'screen' };
  const ON_LIGHT = { scheme: 'light', light: 'all', dark: 'not all' };
  for (const [appearance, systemDark, want] of [
    ['system', false, ON_LIGHT],
    ['system', true, ON_DARK],
    ['light', true, ON_LIGHT],
    ['sepia', true, ON_LIGHT],
    ['dark', false, ON_DARK],
    ['dark', true, ON_DARK],
  ] as [string, boolean, typeof ON_DARK][]) {
    const head = runHead(appearance, systemDark);
    const app = appScheme(appearance, systemDark);
    const label = `${appearance} on a ${systemDark ? 'dark' : 'light'} system`;
    assert.deepStrictEqual(
      { scheme: head.scheme, light: head.light, dark: head.dark },
      want,
      `${label}: the head script draws it ${want.scheme}, highlight.js's dark sheet screen-only`,
    );
    assert.deepStrictEqual(
      { scheme: app.scheme, light: app.light, dark: app.dark },
      want,
      `${label}: and applyScheme agrees with it`,
    );
    assert.strictEqual(head.tint, appearance === 'sepia' ? 'sepia' : undefined,
      `${label}: tinted only for sepia`);
  }
  assert.deepStrictEqual(
    { scheme: runHead(null, true).scheme, light: runHead(null, false).scheme },
    { scheme: 'dark', light: 'light' },
    'with nothing saved, the head script follows the system, as the default System does',
  );
  // Whether it moved is what decides a repaint, so a second call with nothing changed says no
  // and a pinned scheme the system moves under says no too.
  const moving = appScheme('system', false);
  assert.ok(moving.moved && !moving.again, 'applyScheme says when the scheme moved, and only then');
  moving.ctx.darkMode.matches = true;
  assert.strictEqual(vm.runInContext('applyScheme()', moving.ctx), true, 'System follows it');
  moving.ctx.settings.appearance = 'dark';
  moving.ctx.darkMode.matches = false;
  assert.strictEqual(vm.runInContext('applyScheme()', moving.ctx), false,
    'a pinned Dark does not move with the system');

  // Wired: on every setting, and on the system's change, with diagrams redrawn only on a move.
  const applySettingsSrc = pageJs.match(/\nfunction applySettings\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(applySettingsSrc, /const schemeMoved = applyScheme\(\);/,
    'applySettings applies the scheme');
  assert.match(applySettingsSrc, /if \(\(sepia\(\) !== wasSepia \|\| schemeMoved\) && retheme\(\)\)/,
    'and redraws diagrams when it or the tint moved');
  assert.match(pageJs, /export function retheme\(\) \{\s*if \(!mermaid\) return false;/,
    'once Mermaid has drawn something in the old colours');
  assert.match(
    pageJs,
    /darkMode\.addEventListener\('change', \(\) => \{\s*if \(!applyScheme\(\)\) return;/,
    "the system's change goes through applyScheme, and repaints only if the scheme moved",
  );
  assert.ok(
    pageJs.includes("const dark = () => document.documentElement.dataset.scheme === 'dark';"),
    'diagrams read the scheme off the page',
  );
  assert.match(pageJs, /theme: dark\(\) \? 'dark' : 'default'/, 'and Mermaid is drawn in it');
  assert.ok(!/darkMode\.matches \?/.test(pageJs), "and not in the system's");

  // The stylesheets read the attribute, and none of them the media query.
  assert.match(pageHtml, /<link id="hljsLight" rel="stylesheet" href="vendor\/hljs-light\.css" \/>/,
    "highlight.js's light sheet has an id for the scheme to switch");
  assert.match(pageHtml, /<link id="hljsDark" rel="stylesheet" href="vendor\/hljs-dark\.css" \/>/,
    'and so does its dark one, neither with a media query of its own');
  assert.ok(pageHead.indexOf('id="hljsDark"') < pageHead.indexOf('<script>'),
    'both are in the head before the script that looks them up');
  assert.match(pageCss, /@media screen \{\s*:root\[data-scheme="dark"\] \{\s*color-scheme: dark;/,
    "the page's dark palette is keyed to the attribute, on screen only, with the browser's own");
  assert.ok(!pageCss.includes('prefers-color-scheme'), 'and styles.css asks no media query');

  // github-markdown-css, keyed by build:web.
  const require = createRequire(import.meta.url);
  const shipped = fs.readFileSync(
    require.resolve('github-markdown-css/github-markdown.css'),
    'utf8',
  );
  const keyed = keyToScheme(shipped);
  assert.ok(!keyed.includes('prefers-color-scheme'), 'the markdown palette follows no media query');
  const darkBody = keyed.match(
    /@media screen \{\s*:root\[data-scheme="dark"\] \.markdown-body \{([^}]*)\}\s*\}/,
  )?.[1];
  const lightBody = keyed.match(
    /(?:^|\n)\.markdown-body \{([^}]*color-scheme: light;[^}]*)\}/,
  )?.[1];
  assert.ok(darkBody?.includes('--bgColor-default:'),
    'its dark palette is under data-scheme, on screen');
  assert.ok(lightBody?.includes('--bgColor-default:'), 'and its light one is the default');
  const names = (body) => [...body.matchAll(/(--[\w-]+):/g)].map((m) => m[1]).sort().join();
  assert.strictEqual(names(darkBody), names(lightBody),
    'the dark palette sets every variable the light one does, so nothing light shows through');
  assert.throws(() => keyToScheme('.markdown-body { color: red; }'), /found none/,
    'a release with the palettes moved stops the build');
  assert.throws(() => keyToScheme(shipped + shipped), /found dark, dark, light, light/,
    'and so does one with more than the two');
  const served = await (await fetch(base + '/vendor/github-markdown.css')).text();
  assert.strictEqual(served, keyed, 'the CLI serves the keyed one, not the one in node_modules');

  // Shown in a browser tab, where the rest of General is not.
  const general = settingsTsx.match(/<section([^>]*)>\s*<h3>General<\/h3>([\s\S]*?)<\/section>/);
  assert.ok(general && !general[1].includes('data-shell'),
    "General is not the shell's as a whole");
  const rowOf = (id) => general[2].split('<div class="row"').find((r) => r.includes(`id="${id}"`));
  assert.ok(rowOf('setAppearance').startsWith('>'), 'Appearance shows in a browser tab');
  assert.ok(rowOf('setReopen').startsWith(' data-shell="">'), 'On launch does not');
  assert.ok(rowOf('setFinder').startsWith(' data-shell="">'), 'nor does Files from Finder');
});
