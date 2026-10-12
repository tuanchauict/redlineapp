import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert';
import { rootUrl } from '../src/hosts/node/root.js';
import { pageJs, pageHtml, pageCss, settingsTsx } from './support.js';

// A menu item reaches the page over an event, through the seam, and every one
// of the three is a separate file that can be right on its own: the menu item
// that emits an event nobody listens for is greyed out by nothing and does
// nothing when picked. ⌘B and ⌥⌘B are checked as a pair because the second was
// added by copying the first, which is exactly how one of the three gets
// missed. The browser tab has no menu, so the key is the page's to catch.
const menuRs = fs.readFileSync(rootUrl('shell/src/menu.rs'), 'utf8');
const seamJs = fs.readFileSync(rootUrl('src/hosts/tauri/native.ts'), 'utf8');

test('⌘B, ⌥⌘B and ⌘F reach the page from the menu and from the keyboard', async () => {
  for (const [item, accel, event, hook] of [
    ['side', 'CmdOrCtrl+B', 'md:toggle-side', 'onToggleSide'],
    ['sidetoc', 'Alt+CmdOrCtrl+B', 'md:toggle-toc', 'onToggleToc'],
    ['find', 'CmdOrCtrl+F', 'md:find', 'onFind'],
  ]) {
    assert.ok(menuRs.includes(`with_id("${item}"`), `View has an item for ${item}`);
    assert.ok(menuRs.includes(`accelerator("${accel}")`), `under ${accel}`);
    assert.ok(menuRs.includes(`"${item}" => win::to_front(app, "${event}"`), `sending ${event}`);
    // Whatever `cb` is typed as: this is about which event reaches which hook, not about the type.
    const hears = new RegExp(`${hook}: \\(cb\\b.*?\\) => on(?:<[^>]*>)?\\('${event}'`);
    assert.match(seamJs, hears, `the seam hears it as ${hook}`);
    assert.ok(pageJs.includes(`native.${hook}(`), `and the page acts on ${hook}`);
  }
  assert.match(pageJs, /!native && e\.code === 'KeyB'/, 'a browser tab catches the key itself');
  assert.match(pageJs, /if \(e\.altKey\) setTocSide/, 'with Option choosing the contents');
  assert.match(pageJs, /!native && e\.code === 'KeyF'/, 'and ⌘F, to beat the browser\'s own find');
});

// Print needs no key of its own in a browser tab -- ⌘P is the browser's -- and
// in the app it never reaches the page at all: `window.print()` is a no-op in
// WKWebView, so the menu drives the native print pipeline on the front window
// directly, through `print_window` rather than wry's own `print()` -- see
// print_window's doc comment in menu.rs for why: wry forces NSPrintInfo's
// margin to zero, and WebKit paginates against that margin, not `@page` CSS.
test('Print hides the chrome, forces a light page and prints with a real native margin', async () => {
  assert.ok(menuRs.includes(`with_id("print"`), 'View has an item for print');
  assert.ok(menuRs.includes('accelerator("CmdOrCtrl+P")'), 'under CmdOrCtrl+P');
  assert.match(
    menuRs,
    /"print" => \{[\s\S]*?win::front\(app\)[\s\S]*?print_window\(&w\)/,
    'dispatch prints the front window directly, not through the page',
  );
  assert.match(
    menuRs,
    /fn print_window\(w: &tauri::WebviewWindow\) \{[\s\S]*?setTopMargin\(72\.0\)/,
    "print_window sets a real native margin, since wry's own print() forces one to zero",
  );
  assert.match(pageCss, /@media print \{/, 'a print stylesheet exists');
  assert.match(
    pageCss,
    /@media print \{[\s\S]*?\.bar,[\s\S]*?dialog \{[\s\S]*?display: none !important;[\s\S]*?\}/,
    'the window chrome is hidden on paper',
  );
  assert.match(
    pageCss,
    /@media print \{[\s\S]*?color-scheme: light;/,
    'and the page is forced light, whatever the system theme is',
  );
});

// Restoring several tabs opens several documents, each its own file read, store
// and git subprocess -- sequential awaits would make the sidebar sit empty for
// the sum of every open instead of the slowest one.
test('find in document wired end to end', async () => {
  assert.match(seamJs, /await Promise\.all\(\s*paths\.map\(async \(abs\)/,
    'tabs are retained at once');

  // A native window's starting document comes from `onTabs`'s own first answer,
  // not from this module's own blind initial load -- the two used to race, and
  // whichever settled last won even if it was the guess with no id at all. That
  // let a tab go on looking highlighted in the sidebar while the pane quietly
  // went back to showing whatever loaded slower.
  assert.ok(
    pageJs.includes('const firstTabShown = new Promise'),
    'the first document is awaited rather than raced for',
  );
  assert.ok(
    pageJs.includes('.finally(openedFirstTab)'),
    "onTabs resolves it once its own load settles, win or lose",
  );
  assert.match(
    pageJs,
    /if \(native\) \{\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*await firstTabShown;\s*\} else \{/,
    'a native window waits for that answer instead of calling load() itself',
  );
  // Watched only if it painted: with the web app's welcome up there is no document to watch.
  assert.match(
    pageJs,
    /else if \(await load\(\{ keepScroll: false \}\)\) \{\s*connect\(\);\s*\}/,
    'and any other window loads, and watches what it showed',
  );

  // Find in the current document. The three-file shape above gets it a menu item
  // and a key; what is particular to it is that `#doc` is replaced whole on every
  // paint (see `paint`), so a match held from before a repaint is a reference to
  // a node no longer on the page — the bar has to redo the search rather than
  // remember where it looked last.
  assert.match(pageHtml, /id="findBar"/, 'the find bar has somewhere to show');
  assert.match(pageHtml, /id="findInput"/, 'something to type the query into');
  assert.match(pageHtml, /id="findCount"/, 'and somewhere to say how many it found');
  assert.match(pageJs, /function markMatches/, 'matches are found fresh, not kept across a paint');
  assert.match(pageJs, /!stay && findOpen\.value/, 'and paint redoes it after #doc is replaced');
  assert.ok(pageCss.includes('.find-bar[hidden]'), 'the bar itself goes away with `hidden`');
  assert.match(pageCss, /mark\.search-hit \{/, 'a match is styled');
  assert.match(pageCss, /mark\.search-hit\.current \{/, 'and the current one is told apart');
});

// ...and reach the window it was addressed to, and no other. The shell names a
// window in every one of those emits, but naming it is only half of it: Tauri
// exempts a listener registered without a target from the filter, so a page
// that signs up the easy way is signed up for every window's mail. That cost a
// bug where one window's "Open files" listed another window's documents, and —
// once the foreign paths could not be held — listed nothing at all under a
// document that was still on screen.
//
// Asserted by counting, not by matching: the fix is that *no* registration in
// the seam is untargeted, which a grep for the good one cannot show. Everything
// goes through `on`, so one `listen` is the whole of it.
const hostRs = fs.readFileSync(rootUrl('shell/src/host.rs'), 'utf8');

test('a window only hears the events addressed to it', async () => {
  const winRs = fs.readFileSync(rootUrl('shell/src/win.rs'), 'utf8');
  assert.strictEqual(
    // `listen<T>(` too: the type argument must not hide a registration from the count.
    (seamJs.match(/\blisten(?:<[^>]*>)?\(/g) ?? []).length,
    1,
    'the seam registers for the shell in exactly one place',
  );
  assert.ok(
    seamJs.includes('{ target: host.label }'),
    'naming the window it is in, so emit_to means what it says',
  );
  assert.match(hostRs, /pub label: String/, 'which is what the handoff tells it');
  assert.match(winRs, /Handoff::new\(app, &label,/, 'from the window being built');
});

// A double-clicked document survives the launch it arrives during.
// Set Redline as the handler for `.md` and every double-click, and every `open
// doc.md` on an app that was not already running, killed it: macOS delivers
// `application:openURLs:` from inside `-[NSApplication finishLaunching]`, which
// is *before* the did-finish-launching notification Tauri runs its setup hook
// on. So the open landed on an app with no managed state, `State::get` panicked
// and `panic = "abort"` turned that into SIGABRT before a window ever existed.
// Nothing to see from the outside -- `open` returns 0 either way -- which is
// why this is asserted here rather than left to be noticed.
//
// Grepped rather than run, because the route is an Apple Event into a bundle
// and there is no bundle in a `node` process. Three parts, and the first is the
// one that was missing: the guard has to come before anything in `arrive` that
// reads state, the files have to be kept rather than dropped, and the hook has
// to go looking for them.
const mainRs = fs.readFileSync(rootUrl('shell/src/main.rs'), 'utf8');

test('a document opened from Finder outlives the launch it arrives during', async () => {
  const arriveBody = mainRs.slice(mainRs.indexOf('fn arrive('));
  assert.ok(
    arriveBody.indexOf('try_state::<win::Shell>()') <
      arriveBody.indexOf('if files.is_empty()'),
    'nothing in arrive() reads the shell before checking there is one',
  );
  assert.match(mainRs, /static PENDING: Mutex<Vec<PathBuf>>/, 'files that arrive too early wait');
  assert.match(mainRs, /PENDING\.lock\(\)\.unwrap\(\)\.extend/, 'rather than being dropped');
  assert.match(mainRs, /PENDING\.lock\(\)\.unwrap\(\)\.drain\(\.\.\)/, 'and setup takes them');
  // A second process exits with only its arguments, so what Finder gave it is left in
  // the inbox for the first, which looks there when told of a launch with no files.
  assert.match(mainRs, /inbox_put\(app, files\)/, 'a process that may exit leaves its files');
  assert.match(mainRs, /left = inbox_take\(app\)/, 'a bare launch looks for them');
  assert.match(mainRs, /RunEvent::Opened \{ urls \}/, 'from the event a Finder open comes as');
  // And the association itself, since a double-click that never reaches the app
  // is the same bug from the reader's side.
  const tauriConf = JSON.parse(
    fs.readFileSync(rootUrl('shell/tauri.conf.json'), 'utf8'),
  );
  const assoc = tauriConf.bundle.fileAssociations ?? [];
  assert.ok(
    assoc.some((a) => a.ext?.includes('md')),
    'the app claims .md, so Finder can hand it one in the first place',
  );
});

// The CI section moved to test/ci.test.ts, which read this file for the update check below.
test('check for updates is wired from the menu to the settings sheet', async () => {
  const cmdsRs = fs.readFileSync(rootUrl('shell/src/cmds.rs'), 'utf8');

  // The check itself: only ever asked for, and answered where the version is.
  // Every piece is a way for it to be built and unreachable — a command not in
  // the handler list is refused silently, an event the page never listens for
  // is a menu item that does nothing, and a row nobody fills reads "Redline".
  assert.match(cmdsRs, /pub async fn check_update/,
    'the check is async, so a slow network cannot freeze the main thread');
  assert.match(mainRs, /cmds::check_update,/, 'and registered, or the page is refused');
  assert.match(menuRs, /with_id\("checkupdate", "Check for Updates…"\)/, 'the menu offers it');
  assert.match(menuRs, /"checkupdate" => win::to_front\(app, "md:check-update"/,
    'and hands it to the window in front');
  assert.match(seamJs, /onCheckUpdate: \(cb\b.*?\) => on\('md:check-update'/,
    'which listens for it');
  assert.match(pageJs, /native\.onCheckUpdate\(/, 'and answers it');
  assert.match(settingsTsx, /<section id="aboutSec" data-shell="">/,
    'in a section only the desktop app shows');
  assert.match(pageJs, /mountSettings\(\$\('prefsSlot'\), native\?\.version \?\? '',/,
    'which says what this is');
  assert.match(settingsTsx, /<span id="setVersion">\{version\}<\/span>/, 'by its version');
  assert.match(hostRs, /version: app\.package_info\(\)\.version\.to_string\(\)/,
    'from the bundle the app was built as');
  assert.match(pageJs, /\n  check: checkUpdate,\n/, 'with a button that asks');
  assert.match(settingsTsx, /id="checkUpdate"[\s\S]{0,120}?onClick=\{actions\.check\}/,
    'and the button is wired to it');
  // Counted rather than looked for: the promise is that *nothing else* calls it,
  // so the one call there is has to be the menu's.
  assert.deepStrictEqual(
    pageJs.match(/(?<![.\w])checkUpdate\(\);/g),
    ['checkUpdate();'],
    'and nothing but the menu calls it — not a timer, not launch',
  );
  assert.match(
    pageJs,
    /native\.onCheckUpdate\(\(\) => \{[\s\S]{0,200}?checkUpdate\(\);/,
    'that one is the menu',
  );
  // The advice depends on how this copy got here. A cask moves the app into
  // /Applications, so the bundle's own path cannot tell; the Caskroom can.
  assert.match(cmdsRs, /Caskroom\/redline/, 'a Homebrew copy is told apart from a dragged one');
  assert.match(pageJs, /const BREW_UPGRADE = 'brew upgrade --cask redline'/,
    'and told to upgrade through Homebrew');
});
