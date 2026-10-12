import { test } from 'node:test';
import path from 'node:path';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import { nodePlatform } from '../../src/hosts/node/platform.js';
import { rootUrl } from '../../src/hosts/node/root.js';
import { scratch, until } from '../support.js';

const tmp = scratch();

// One store, two processes.
// Two DocStores on one file stand in for two processes: each holds the index as it read it,
// which is what made a write from one undo the other's. (docs/architecture.md, The store)
test('one store, two processes', async (t) => {
  let A, v4;
  const { DocStore, hashContent } = await import('../../src/reader/store.js');
  const { createReader } = await import('../../src/reader/reader.js');

  await t.test('two processes share a store without undoing each other', async () => {
    const shared = path.join(tmp, 'shared.md');
    const text = (n) => `# Shared\n\nVersion ${n}.\n`;
    A = await DocStore.open(shared, nodePlatform);
    const v1 = (await A.record(text(1))).hash;
    const B = await DocStore.open(shared, nodePlatform); // opened after v1, and never told about v2

    // A mark-read is not undone by another process saving a version.
    const v2 = (await A.record(text(2))).hash;
    await A.setBaseline(v2);
    const v3 = (await B.record(text(3))).hash; // B still thinks the baseline is v1
    const fresh = await DocStore.open(shared, nodePlatform);
    assert.strictEqual(fresh.baseline, v2, 'a mark-read survives the other process recording');
    assert.deepStrictEqual(
      fresh.data.history.map((h) => h.hash),
      [v1, v2, v3],
      'and neither process\'s version is lost',
    );

    // A check-off survives the other process recording.
    await B.setAcked('shared-key', true);
    v4 = (await A.record(text(4))).hash;
    assert.deepStrictEqual(
      (await DocStore.open(shared, nodePlatform)).acked,
      ['shared-key'],
      'a check-off survives the other process saving',
    );

    // Cleared history does not come back.
    await A.prune(v3);
    await B.record(text(5));
    const after = await DocStore.open(shared, nodePlatform);
    assert.deepStrictEqual(
      after.data.history.map((h) => h.hash).filter((h) => [v1, v2, v3].includes(h)),
      [],
      'a prune in one process stays pruned when the other records',
    );
    assert.strictEqual(after.data.history.length, 2, 'and what is left is the newest two');
    assert.ok(after.data.history.some((h) => h.hash === v4), 'including the one the pruner saw');

    // Each notices the other: refresh says so once, and has the new index.
    await A.setBaseline(v4);
    assert.strictEqual(await B.refresh(), true, 'the other process is noticed');
    assert.strictEqual(B.baseline, v4, 'with its baseline');
    assert.strictEqual(await B.refresh(), false, 'and once');
    await B.setCompare('read');
    assert.strictEqual(await A.refresh(), true, 'both ways');
    // Its own write is not news: nothing to announce after it saves.
    await A.setCompare('git:HEAD');
    assert.strictEqual(await A.refresh(), false, 'a process does not notice itself');
    // An update that merged what another process had written does announce it.
    await B.setCompare('read'); // B writes; A has not looked since
    await A.setAcked('another', true); // A merges B's write into its own
    assert.strictEqual(await A.refresh(), true,
      'a merge is announced, since the poll cannot see it');

    // A torn index is read again before it is believed.
    const idx = A.file;
    const good = fs.readFileSync(idx, 'utf8');
    fs.writeFileSync(idx, good.slice(0, good.length >> 1));
    setTimeout(() => fs.writeFileSync(idx, good), 20);
    assert.strictEqual(
      (await DocStore.open(shared, nodePlatform)).data.history.length,
      2,
      'an index caught mid-write is read once more',
    );

    // Two updates at once in one process both land.
    await Promise.all([A.setAcked('p', true), A.setAcked('q', true)]);
    assert.ok(['p', 'q'].every((k) => A.acked.includes(k)), 'concurrent changes both land');
  });

  // Atomic writes.
  await t.test('a write replaces the file whole', async () => {
    const target = path.join(tmp, 'atomic.json');
    const bodies = Array.from({ length: 12 }, (_, i) => `${i}:`.repeat(20000));
    await Promise.all(bodies.map((b) => nodePlatform.writeText(target, b)));
    assert.ok(bodies.includes(fs.readFileSync(target, 'utf8')), 'a write lands whole, never mixed');
    assert.deepStrictEqual(
      fs.readdirSync(tmp).filter((n) => n.endsWith('.writing')),
      [],
      'and leaves nothing beside it',
    );
    await assert.rejects(nodePlatform.writeText(path.join(tmp, 'no', 'such', 'dir.json'), 'x'));
    assert.match(
      fs.readFileSync(rootUrl('src/hosts/node/platform.ts'), 'utf8'),
      /\.writing/,
      'the node platform writes through a temporary file',
    );
  });

  // gc leaves young objects alone.
  let hourAgo;
  await t.test('gc has a grace period', async () => {
    const objectsDir = path.join(process.env.REDLINE_HOME, 'objects');
    const young = path.join(objectsDir, 'a'.repeat(16) + '.md');
    const old = path.join(objectsDir, 'b'.repeat(16) + '.md');
    fs.writeFileSync(young, 'young and unreferenced\n');
    fs.writeFileSync(old, 'old and unreferenced\n');
    hourAgo = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(old, hourAgo, hourAgo);
    await DocStore.gc(nodePlatform);
    assert.ok(fs.existsSync(young), 'gc keeps an unreferenced object younger than ten minutes');
    assert.ok(!fs.existsSync(old), 'and removes one that is older');
    assert.ok(fs.existsSync(A.objectPath(v4)), 'and what an index names is never touched');
    fs.rmSync(young);
  });

  // A version that comes back is made young again.
  // Its object is still on disk, unreferenced and old, so a sweep in another process that
  // lands between `record` finding it and the index naming it would take it. The sweep is
  // run at exactly that moment: when the index is read for the update.
  await t.test('a version that comes back is not swept', async () => {
    let sweepNow = false;
    const sweeping = {
      ...nodePlatform,
      async readText(p) {
        if (sweepNow && p === racing.file) {
          sweepNow = false;
          await DocStore.gc(nodePlatform);
        }
        return nodePlatform.readText(p);
      },
    };
    const racing = await DocStore.open(path.join(tmp, 'back.md'), sweeping);
    const returning = '# Back\n\nForgotten once, and written again.\n';
    const returningObject = racing.objectPath(hashContent(returning));
    fs.writeFileSync(returningObject, returning);
    fs.utimesSync(returningObject, hourAgo, hourAgo);
    sweepNow = true; // armed only now: opening the store reads the index too
    const { hash: returned } = await racing.record(returning);
    assert.ok(!sweepNow, 'the sweep ran between the object and the index');
    assert.strictEqual(
      await racing.read(returned),
      returning,
      'an old object a version comes back to survives a sweep before the index names it',
    );

    // Git's versions go through the same door.
    const committed = '# Back\n\nAs it was committed.\n';
    const committedObject = racing.objectPath(hashContent(committed));
    fs.writeFileSync(committedObject, committed);
    fs.utimesSync(committedObject, hourAgo, hourAgo);
    await racing.importGit([{ text: committed, ts: 1, git: { sha: 'c0ffee', subject: 'x' } }]);
    assert.ok(
      Date.now() - fs.statSync(committedObject).mtimeMs < 60 * 1000,
      'and so is one a commit comes back to',
    );
  });

  // Noticing, end to end.
  await t.test('a reader notices another process marking a version read', async () => {
    const both = path.join(tmp, 'both.md');
    fs.writeFileSync(both, '# Both\n\nFirst.\n');
    const r1 = await createReader({ platform: nodePlatform, pollMs: 50 });
    const r2 = await createReader({ platform: nodePlatform, pollMs: 50 });
    const id1 = await r1.retain(both);
    const id2 = await r2.retain(both);
    fs.writeFileSync(both, '# Both\n\nFirst.\n\nSecond.\n');
    await until(async () => (await r2.doc(id2, 'read')).history.length >= 2, 'both to see v2');
    await until(async () => (await r1.doc(id1, 'read')).history.length >= 2, 'both to see v2');
    const heard = [];
    r2.subscribe(id2, (e) => heard.push(e.type));
    await r1.markRead(id1);
    // A `history` is not proof of the mark: r1 recording v2 moved the index under r2 too, and the
    // poll that notices that can land after the subscribe and before the mark. So the wait is for
    // both, the event and the row, and a busy runner that orders them that way waits a poll more.
    const marked = async () =>
      (await r2.doc(id2, 'last:read')).history.find((h) => h.current)?.baseline;
    await until(
      async () => heard.includes('history') && (await marked()),
      'the other reader to hear of the mark',
      4000,
    );
    assert.ok(await marked(), 'and it sees the version marked read');
    r1.closeAll();
    r2.closeAll();
  });
});

// The store followed the app's name.
// It holds every snapshot of every file ever read, and a rename of the app is
// no reason to start that again from nothing — nor to leave two stores lying
// about, which is what reading the old one where it lay would have meant.
test('the history store follows the app name', async () => {
  const { storeRoot } = await import('../../src/reader/store.js');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-home-'));
  const legacyStore = path.join(fakeHome, '.md-reader');
  const newStore = path.join(fakeHome, '.redline');
  fs.mkdirSync(path.join(legacyStore, 'objects'), { recursive: true });
  fs.writeFileSync(path.join(legacyStore, 'objects', 'abc.md'), '# kept\n');

  const realHome = process.env.HOME;
  const realStore = process.env.REDLINE_HOME;
  // The override wins over everything, this test included.
  delete process.env.REDLINE_HOME;
  process.env.HOME = fakeHome;
  try {
    assert.strictEqual(await storeRoot(nodePlatform), newStore, 'the store is under the new name');
    assert.ok(!fs.existsSync(legacyStore),
      'and the old directory is not left behind as a second copy');
    assert.strictEqual(
      fs.readFileSync(path.join(newStore, 'objects', 'abc.md'), 'utf8'),
      '# kept\n',
      'every snapshot came across with it',
    );
    // Once there is a store under the new name it is the store, whatever turns up
    // beside it later: nothing is merged in, and nothing is moved over it.
    fs.mkdirSync(legacyStore);
    fs.writeFileSync(path.join(legacyStore, 'stray.json'), '{}');
    assert.strictEqual(await storeRoot(nodePlatform), newStore, 'the existing store wins');
    assert.ok(fs.existsSync(path.join(legacyStore, 'stray.json')), 'and is not written into');
  } finally {
    process.env.HOME = realHome;
    process.env.REDLINE_HOME = realStore;
  }
  assert.strictEqual(await storeRoot(nodePlatform), realStore,
    'an explicit REDLINE_HOME still overrides both');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});
