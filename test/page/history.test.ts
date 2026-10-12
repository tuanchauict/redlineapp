import { test } from 'node:test';
import assert from 'node:assert';
import { pageCss, pageHtml, pageJs } from '../support.js';

// History moved columns, and three places still had to agree where it lives
// now: the paint function must not skip itself because the *other* column is
// shut, opening the right column must be what fills a list that was never
// built while it was closed, and the counter that answers "changed since
// what?" must open the column the answer is actually in.
test('History paints, opens and is reached through the right column', async () => {
  assert.match(
    pageJs,
    /function History\([\s\S]*?if \(!d \|\| !state\.tocSide\) return null;/,
    'History paints against the column it is actually in',
  );
  assert.match(
    pageJs,
    /function setTocSide[\s\S]*?paintToc\(state\.data\);\s*paintHistory\(state\.data\);/,
    'opening that column fills both of its lists',
  );
  assert.match(
    pageJs,
    /\$\('tocBtn'\)\.addEventListener\('click', \(\) => setTocSide/,
    'and the column history is in has a button of its own, which the counter no longer is',
  );
  assert.match(pageHtml, /id="tocBtn"[^>]*title="[^"]*⌥⌘B/, 'whose tooltip names the key');
});

// The remembered comparison. The reader keeps it, but only if the page asks in
// the form that means "show me this document" rather than "compare it against
// this": every site that *shows* one has to send `last:`, and the one that
// changes the setting must not, or changing it would look like it did nothing.
test('remembered comparison wired end to end', async () => {
  const KEPT = /const keptBaseline = \(\) => `last:\$\{defaultBaseline\(\)\}`/;
  assert.match(pageJs, KEPT, 'the form that means "show me this document" exists');
  assert.strictEqual(
    (pageJs.match(/state\.baseline = keptBaseline\(\)/g) || []).length,
    4,
    'and is sent on first open, a tab switch, a file event and following a link',
  );
  assert.strictEqual(
    (pageJs.match(/state\.baseline = defaultBaseline\(\)/g) || []).length,
    1,
    'while changing the setting still names a baseline outright',
  );
  // And since a choice now sticks, the list has to hold the way out of one: the
  // row carrying the read mark names `read`, not its own hash, or there would be
  // nothing to click to stop comparing against a fixed version.
  assert.match(
    pageJs,
    /state\.baseline = v\.baseline \? 'read' : `snap:\$\{v\.hash\}`/,
    'the read row is the way back to a baseline that moves',
  );
});

// Reading one version by itself is a mode in the History heading. Each half is
// silent when dropped: no switch and it cannot be reached, no render branch and
// the switch lights up over a diff, no tag and an old version passes for the file.
test('reading one version by itself wired end to end', async () => {
  assert.match(pageHtml, /id="histSolo"/, 'the switch is in the History heading');
  assert.match(pageJs, /\$\('histSolo'\)\.addEventListener\('click', toggleSolo\)/, 'and wired up');
  assert.match(pageJs, /key === 'v'\) toggleSolo\(\)/, 'and reached from `v` too');
  assert.match(
    pageJs,
    /renderDocument\(md, soloText\(data\), null\)/,
    'it renders a version plainly',
  );
  assert.match(pageJs, /if \(state\.solo\) \{/, 'and the marks switch redraws under it');
  assert.match(pageJs, /id="soloTag"/, 'the bar names the version on the page');
  assert.ok(
    /id="soloTag"[^>]*onClick=\{actions\.unsolo\}/.test(pageJs) &&
      /unsolo: \(\) => setSolo\(false\),/.test(pageJs),
    'and is the way back to the changes',
  );
  assert.match(pageCss, /\.side-tog\[hidden\]/, 'a switch that sets display still hides');
  assert.ok(!pageJs.includes('redline:solo'), 'and a restart never opens on an old version');
});
