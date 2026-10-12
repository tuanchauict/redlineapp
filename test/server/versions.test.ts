import { test } from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert';
import { createServer } from '../../src/hosts/node/server.js';
import { clientFor, portOf, scratch } from '../support.js';

const tmp = scratch();
/** How much a diff marked, all kinds together. */
const total = (s) => s.added + s.removed + s.modified;

// A version that comes back is still one version.
// Undoing an edit puts content the document has held before back on disk. A
// version is named by the hash of its content, so a second row for it would
// give two rows one name: both would be marked as the version on disk, both as
// the version counted as read, and picking either would light up the other.
let wobble, getW, hashes;
const wobbly = path.join(tmp, 'wobbly.md');

test('a version that comes back is one row', async () => {
  const v1 = '# Wobbly\n\nFirst wording.\n';
  const v2 = '# Wobbly\n\nSecond wording, thought better of.\n';
  fs.writeFileSync(wobbly, v1);
  wobble = await createServer({ file: wobbly });
  await new Promise<void>((r) => wobble.server.listen(0, '127.0.0.1', r));
  getW = clientFor(`http://127.0.0.1:${portOf(wobble.server)}`);
  await getW('/api/doc');
  fs.writeFileSync(wobbly, v2);
  await new Promise((r) => setTimeout(r, 700));
  assert.strictEqual((await getW('/api/doc')).history.length, 2, 'an edit is a version');
  fs.writeFileSync(wobbly, v1);
  await new Promise((r) => setTimeout(r, 700));
  const reverted = await getW('/api/doc');
  hashes = reverted.history.map((h) => h.hash);
  assert.strictEqual(new Set(hashes).size, hashes.length, `one row per version: ${hashes}`);
  assert.strictEqual(reverted.history.length, 2, 'the row moved, it was not added');
  assert.deepStrictEqual(
    reverted.history.filter((h) => h.current).map((h) => h.hash),
    [hashes[0]],
    'the version on disk is marked exactly once, on the newest row',
  );
  // The read mark is on that row too, since v1 is what this document opened on.
  assert.deepStrictEqual(
    reverted.history.filter((h) => h.baseline).map((h) => h.hash),
    [hashes[0]],
    'and so is the version counted as read',
  );
  console.log('✓ a version that comes back is one row', reverted.history.length, 'versions');
});

// ...and the chosen version survives a restart.
// The point of remembering it at all. Kept beside the snapshots rather than in
// the page's own storage: the page does not know which file it is showing until
// the document arrives, so looking the answer up there would mean a first paint
// against the wrong baseline and a visible correction — and a browser tab and
// the app's webview are separate origins, which would give one file two
// memories that disagreed.
test('the chosen version survives a restart', async () => {
  const pickW = 'snap:' + hashes[1];
  const chosenW = await getW('/api/doc?baseline=' + pickW);
  assert.strictEqual(chosenW.baseline, pickW, 'the older version is chosen');
  assert.ok(total(chosenW.stats) > 0, `and marks something: ${JSON.stringify(chosenW.stats)}`);
  wobble.server.close();

  const wobble2 = await createServer({ file: wobbly });
  await new Promise<void>((r) => wobble2.server.listen(0, '127.0.0.1', r));
  const getW2 = clientFor(`http://127.0.0.1:${portOf(wobble2.server)}`);
  const reopened = await getW2('/api/doc');
  assert.strictEqual(reopened.baseline, pickW, 'a restart opens on the version that was chosen');
  assert.deepStrictEqual(reopened.stats, chosenW.stats, 'and shows the same changes it did before');
  // Not the read mark: that is a different pointer, and remembering a comparison
  // must not quietly move what counts as read.
  assert.deepStrictEqual(
    reopened.history.filter((h) => h.baseline).map((h) => h.hash),
    [hashes[0]],
    'the read mark is where it was left, not on the version being compared against',
  );
  wobble2.server.close();
});
