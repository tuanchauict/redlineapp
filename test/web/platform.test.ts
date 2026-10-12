import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { makePaths } from '../../src/core/paths.js';
import { rootUrl } from '../../src/hosts/node/root.js';
import { memoryKv, render, until } from '../support.js';

// The store over a key-value store, and the web platform.
// What the web app runs on, with a Map where IndexedDB will be. `idb.ts` is the one file here
// that is only imported and never run: node has no IndexedDB and this repository has no browser,
// so how it handles a transaction is held by how it is written, and checked by reading it.
// (docs/architecture.md, The web app's reader)
test('the store over a key-value store, and the web platform', async (t) => {
  const { DocStore, hashContent, storeRoot } = await import('../../src/reader/store.js');
  const { createWebPlatform } = await import('../../src/hosts/web/platform.js');
  const { createReader } = await import('../../src/reader/reader.js');
  const ROOT = '/redline';

  await t.test('the store runs over a key-value store: versions, a prune, a sweep, two stores', async () => {
    const { createKvFiles } = await import('../../src/hosts/web/kv-files.js');
    const pp = makePaths('/');

    const realNow = Date.now;

    // #9: the file operations, then DocStore on them.
    const kv = memoryKv();
    const kfs = createKvFiles(kv, ROOT);
    const aa = '/redline/objects/aa.md';
    assert.strictEqual(await kfs.readText(aa), null, 'a missing file reads as null');
    assert.strictEqual(await kfs.modified(aa), null, 'and has no modified time');
    const putsBefore = kv.seen.puts;
    await kfs.writeText(aa, 'one');
    assert.strictEqual(
      kv.seen.puts - putsBefore,
      1,
      'a write is one put, so a file is replaced whole',
    );
    await kfs.writeText(aa, 'two');
    assert.strictEqual(await kfs.readText(aa), 'two', 'and a second write replaces the first');

    const stamped = '/redline/docs/t.json';
    const frozen = realNow();
    Date.now = () => frozen;
    try {
      const stamps = [];
      for (let i = 0; i < 3; i++) {
        await kfs.writeText(stamped, String(i));
        stamps.push(await kfs.modified(stamped));
      }
      assert.ok(
        stamps[0] < stamps[1] && stamps[1] < stamps[2],
        'modified moves on every write, even inside one millisecond',
      );
      Date.now = () => frozen - 5000;
      await kfs.writeText(stamped, 'back');
      assert.ok((await kfs.modified(stamped)) > stamps[2], 'and when the clock steps back');
    } finally {
      Date.now = realNow;
    }

    await kfs.writeText('/redline/objects/bb.md', 'b');
    assert.deepStrictEqual(
      await kfs.readDir('/redline/objects'),
      ['aa.md', 'bb.md'],
      'readDir is names',
    );
    assert.deepStrictEqual(
      await kfs.readDir(ROOT),
      ['docs', 'objects'],
      'a directory is listed once, however many files are in it',
    );
    assert.deepStrictEqual(
      await kfs.readDir('/redline/obj'),
      [],
      'and a name that only begins one is not it',
    );
    assert.ok(
      (await kfs.exists(aa)) && (await kfs.exists('/redline/objects')),
      'a file and the directory it is in both exist',
    );
    assert.ok(
      !(await kfs.exists('/redline/objectsx')) && !(await kfs.exists('/redline/none.md')),
      'and neither does what is only a prefix, or is not there',
    );
    await kfs.remove('/redline/objects/bb.md');
    await kfs.remove('/redline/objects/bb.md');
    assert.strictEqual(
      await kfs.readText('/redline/objects/bb.md'),
      null,
      'remove removes, once or twice',
    );

    const cc = '/redline/objects/cc.md';
    assert.strictEqual(await kfs.rename(aa, cc), true, 'a file renames');
    assert.deepStrictEqual(
      [await kfs.readText(aa), await kfs.readText(cc)],
      [null, 'two'],
      'and is where it was moved to, and no longer where it was',
    );
    assert.strictEqual(await kfs.rename(aa, cc), false,
      'a file that is not there renames to false');
    assert.strictEqual(
      await kfs.rename('/redline/objects', '/redline/moved'),
      false,
      'and so does a directory',
    );
    assert.deepStrictEqual(await kfs.readDir(ROOT), ['docs', 'objects'],
      'which stays where it was');
    const failing = {
      ...kv,
      tx: (fn) =>
        kv.tx((t) =>
          fn({
            ...t,
            del: async () => {
              throw new Error('disk full');
            },
          }),
        ),
    };
    const ee = '/redline/objects/ee.md';
    await assert.rejects(createKvFiles(failing, ROOT).rename(cc, ee), /disk full/);
    assert.deepStrictEqual(
      [await kfs.readText(cc), await kfs.readText(ee)],
      ['two', null],
      'a rename that fails half way is no rename: the file is in one place, not two or none',
    );
    for (const outside of ['/etc/passwd', '/redlinex/a.md', ROOT]) {
      await assert.rejects(
        () => kfs.writeText(outside, 'x'),
        /not under/,
        `a write to ${outside} is refused`,
      );
      await assert.rejects(() => kfs.readText(outside), /not under/, 'and so is a read of it');
    }

    // DocStore on it, unchanged: the version list, a version that comes back, a prune, a sweep.
    const cold = memoryKv();
    const web1 = {
      ...createKvFiles(cold, ROOT),
      ...pp,
      watch: async () => () => {},
      homeDir: async () => '/home/me',
      env: (name) => (name === 'REDLINE_HOME' ? ROOT : undefined),
      os: 'web',
    };
    const text = (n) => `# A\n\nVersion ${n}.\n`;
    const S = await DocStore.open('/home/me/notes/a.md', web1);
    const v1 = (await S.record(text(1))).hash;
    const v2 = (await S.record(text(2))).hash;
    const v3 = (await S.record(text(3))).hash;
    assert.strictEqual(S.baseline, v1, 'the first version is the baseline');
    assert.ok(
      cold.data.has(S.file) && S.file.startsWith('/redline/docs/'),
      'the index is in the store',
    );
    assert.ok(cold.data.has(S.objectPath(v1)), 'and each version is an object beside it');
    assert.strictEqual(await S.read(v2), text(2), 'a version reads back whole');

    const back = await S.record(text(1));
    assert.deepStrictEqual(
      [back.hash, back.added],
      [v1, true],
      'a version that comes back is recorded',
    );
    const listed = () => S.data.history.map((h) => h.hash);
    assert.deepStrictEqual(listed(), [v2, v3, v1], 'moved to the end, and not listed twice');

    await S.setBaseline(v2);
    assert.strictEqual(await S.prune(v2), 1, 'a prune forgets that version and what is older');
    assert.deepStrictEqual(listed(), [v3, v1], 'and the list is what is left');
    assert.strictEqual(S.baseline, v3,
      'a baseline that was forgotten falls back to the oldest left');
    const reopened = await DocStore.open('/home/me/notes/a.md', web1);
    assert.deepStrictEqual(
      [reopened.baseline, reopened.data.history.map((h) => h.hash)],
      [v3, [v3, v1]],
      'and a store opened afterwards finds it so',
    );

    const young = '/redline/objects/' + 'a'.repeat(16) + '.md';
    await web1.writeText(young, 'young and unreferenced\n');
    await DocStore.gc(web1);
    assert.strictEqual(
      await S.read(v2),
      text(2),
      'gc keeps an unreferenced object younger than ten minutes',
    );
    // Backdating the record is how a Map is made to look old: there is no utimes to call.
    const backdate = (p) => cold.data.set(p, { ...cold.data.get(p), mtime: realNow() - 3600 * 1000 });
    backdate(S.objectPath(v2));
    backdate(S.objectPath(v3));
    await DocStore.gc(web1);
    assert.strictEqual(await S.read(v2), null, 'and sweeps one that is older');
    assert.strictEqual(await S.read(v3), text(3), 'but never one an index names, however old');
    assert.ok((await web1.readText(young)) != null,
      'and a young one is still there after the sweep');

    // Two stores on one kv, as test/reader/store.test.ts has two on one disk.
    const shared = '/home/me/notes/shared.md';
    const body = (n) => `# Shared\n\nVersion ${n}.\n`;
    const A = await DocStore.open(shared, web1);
    const s1 = (await A.record(body(1))).hash;
    const B = await DocStore.open(shared, web1);
    const s2 = (await A.record(body(2))).hash;
    await A.setBaseline(s2);
    const s3 = (await B.record(body(3))).hash;
    const fresh = await DocStore.open(shared, web1);
    assert.strictEqual(fresh.baseline, s2, 'a mark-read survives the other store recording');
    assert.deepStrictEqual(
      fresh.data.history.map((h) => h.hash),
      [s1, s2, s3],
      'and neither store\'s version is lost',
    );
    // `refresh` reads the index only when `modified` has moved, and one clock reading can stand
    // for two writes: here it is made to.
    const stuck = realNow();
    Date.now = () => stuck;
    try {
      await A.refresh();
      await B.record(body(4));
      assert.ok(await A.refresh(), 'a write by the other store is noticed');
      await B.record(body(5));
      assert.ok(await A.refresh(), 'and a second one, in the same millisecond');
    } finally {
      Date.now = realNow;
    }
    assert.strictEqual(
      A.latest.hash,
      hashContent(body(5)),
      'with the newest version in what it sees',
    );
  });

  // #10: the web platform.
  // Handles as the File System Access API shapes them, with the errors it throws for a name
  // that is not there. Every call that could write to a document is a spy: none may be reached.
  await t.test('the web platform reads handles and drops, writes only the store, and runs a reader', async () => {
    const touched = [];
    const asked = [];
    const refusal = (name) => Object.assign(new Error(name), { name });
    const fakeFile = (name, content, lastModified) => ({
      kind: 'file',
      name,
      getFile: async () => ({ text: async () => content, lastModified }),
      createWritable: async () => touched.push('createWritable'),
    });
    const fakeDir = (name, entries) => {
      const find = (n, kind, opts) => {
        asked.push(n);
        if (opts?.create) touched.push('create');
        const entry = entries[n];
        if (!entry) throw refusal('NotFoundError');
        if (entry.kind !== kind) throw refusal('TypeMismatchError');
        return entry;
      };
      return {
        kind: 'directory',
        name,
        getDirectoryHandle: async (n, opts) => find(n, 'directory', opts),
        getFileHandle: async (n, opts) => find(n, 'file', opts),
        removeEntry: async () => touched.push('removeEntry'),
      };
    };
    const notes = fakeDir('notes', { 'a.md': fakeFile('a.md', '# A\n', 200) });
    const handles = new Map<string, { kind: string; name: string; [member: string]: unknown }>([
      ['a', fakeDir('docs', { 'top.md': fakeFile('top.md', '# Top\n', 100), notes })],
      ['solo', fakeFile('one.md', '# One\n', 300)],
    ]);
    const drops = new Map([['d.md', { text: async () => '# Dropped\n', lastModified: 400 }]]);
    const kv2 = memoryKv();
    const web = createWebPlatform({ kv: kv2, root: (id) => handles.get(id) ?? null, drops });

    assert.strictEqual(
      await web.readText('web:a/notes/a.md'),
      '# A\n',
      'a web: path reads through the handles',
    );
    assert.strictEqual(
      await web.modified('web:a/notes/a.md'),
      200,
      'and is as modified as the file says',
    );
    assert.ok(
      (await web.exists('web:a/notes/a.md')) && !(await web.exists('web:a/notes/b.md')),
      'it exists, and a sibling that is not there does not',
    );
    assert.strictEqual(
      await web.readText('web:a/notes/b.md'),
      null,
      'a file that is not there reads as null',
    );
    assert.strictEqual(await web.modified('web:a/notes/b.md'), null, 'and has no modified time');
    assert.strictEqual(await web.readText('web:a/notes'), null,
      'a directory is not a file, so null');
    assert.strictEqual(
      await web.readText('web:never/x.md'),
      null,
      'and so is a folder that was never granted',
    );
    assert.strictEqual(
      await web.readText('web:solo/one.md'),
      '# One\n',
      'a file granted by itself reads',
    );
    assert.strictEqual(await web.readText('web:solo/two.md'), null, 'and has nothing beside it');
    const revoked = refusal('NotAllowedError');
    handles.set('revoked', {
      kind: 'directory',
      name: 'r',
      getFileHandle: async () => {
        throw revoked;
      },
    });
    await assert.rejects(
      () => web.readText('web:revoked/x.md'),
      (err) => err === revoked,
      'a permission taken back is an error, not a file that is missing',
    );

    assert.strictEqual(web.resolve('web:a/x/../../y'), 'web:a/y',
      'a .. stops at the root it is in');
    assert.strictEqual(web.resolve('web:a/../../../etc'), 'web:a/etc', 'however many there are');
    assert.strictEqual(web.resolve('drop:../x.md'), 'drop:x.md', 'in a drop as well');
    assert.strictEqual(web.resolve('/redline/a/../b'), '/redline/b', 'and a store path is tidied');
    asked.length = 0;
    assert.strictEqual(
      await web.readText('web:a/notes/../../../top.md'),
      '# Top\n',
      'a path is resolved before the handles are walked',
    );
    assert.deepStrictEqual(asked, ['top.md'], 'so no handle is ever asked for ..');

    assert.strictEqual(
      await web.readText('drop:d.md'),
      '# Dropped\n',
      'a drop: path reads the dropped file',
    );
    assert.strictEqual(await web.modified('drop:d.md'), 400, 'with its modified time');
    assert.ok(
      (await web.exists('drop:d.md')) && !(await web.exists('drop:no.md')),
      'a drop that is not there does not exist',
    );
    assert.strictEqual(await web.readText('drop:no.md'), null, 'and reads as null');

    await web.writeText('/redline/docs/x.json', '{}');
    assert.strictEqual(
      await web.readText('/redline/docs/x.json'),
      '{}',
      'a store path writes and reads back',
    );
    assert.deepStrictEqual(await web.readDir('/redline/docs'), ['x.json'], 'lists');
    assert.strictEqual(
      typeof (await web.modified('/redline/docs/x.json')),
      'number',
      'and has a time',
    );
    await web.mkdirp('/redline/objects');
    assert.strictEqual(
      await web.rename('/redline/docs/x.json', '/redline/docs/y.json'),
      true,
      'renames',
    );
    assert.strictEqual(await web.readText('/redline/docs/x.json'), null, 'so it has moved');
    await web.writeText('/redline/docs/z.json', 'kept');

    const stored = JSON.stringify([...kv2.data]);
    const refused = [
      'web:a/notes/a.md',
      'web:a',
      'web:solo/one.md',
      'drop:d.md',
      '/home/me/a.md',
      '/redlinex/a.md',
      '/redline/../etc/x',
      'web:a/../../redline/x',
    ];
    for (const p of refused) {
      const calls = {
        writeText: () => web.writeText(p, 'x'),
        mkdirp: () => web.mkdirp(p),
        remove: () => web.remove(p),
        'rename from': () => web.rename(p, '/redline/z'),
        'rename to': () => web.rename('/redline/docs/z.json', p),
        readDir: () => web.readDir(p),
      };
      for (const [what, call] of Object.entries(calls)) {
        // By the platform's own refusal, which says "only", and not by whatever else might throw.
        await assert.rejects(call, /\bonly\b/, `${what} ${p} is refused`);
      }
    }
    assert.strictEqual(JSON.stringify([...kv2.data]), stored, 'and the store is as it was');
    assert.deepStrictEqual(touched, [], 'no handle was asked to write, create or remove anything');
    assert.doesNotMatch(
      fs.readFileSync(rootUrl('src/hosts/web/platform.ts'), 'utf8'),
      /createWritable|removeEntry|create:\s*true/,
      'the web platform has no way to write a document',
    );

    assert.ok(!('spawn' in web), 'the platform has no spawn at all, not one that throws');
    assert.strictEqual(web.env('REDLINE_HOME'), ROOT, 'it answers REDLINE_HOME');
    assert.strictEqual(await storeRoot(web), ROOT, 'so the store is there with nothing to rename');
    assert.strictEqual(
      typeof (await web.watch('drop:d.md', () => {})),
      'function',
      'watch gives a stop',
    );

    // A reader on it, end to end: a dropped file is opened, changes, and is diffed.
    const rdr = await createReader({ platform: web, pollMs: 20 });
    const dropId = await rdr.retain('drop:d.md');
    assert.deepStrictEqual(
      (await rdr.doc(dropId, 'last:read')).caps,
      { git: false, plantuml: false },
      'a reader on it says what it lacks',
    );
    drops.set('d.md', { text: async () => '# Dropped\n\nAgain.\n', lastModified: 401 });
    await until(
      async () => (await rdr.doc(dropId, 'read')).history.length >= 2,
      'the dropped file to change',
    );
    assert.deepStrictEqual(
      render(await rdr.doc(dropId, 'read')).stats,
      { added: 1, removed: 0, modified: 0 },
      'and its change is a change mark',
    );
    assert.ok(
      [...kv2.data.keys()].every((k) => k.startsWith('/redline/')),
      'everything the reader wrote is in the store',
    );
    rdr.closeAll();

    // idb.ts is imported, never run. It is not allowed to reach for `indexedDB` before it is
    // called, or node could not import it; and the two lines below are what the traps in it come
    // down to, so they are held by a grep for want of a browser.
    const hadIdb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    let reached = 0;
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      get() {
        reached++;
      },
    });
    try {
      const { createIdbKv, STORES } = await import('../../src/hosts/web/idb.js');
      const idb = createIdbKv('files');
      assert.strictEqual(reached, 0,
        'idb.ts is imported, and a kv made, without touching indexedDB');
      assert.deepStrictEqual(
        STORES,
        ['files', 'roots', 'opened'],
        'with every store the app will use',
      );
      assert.deepStrictEqual(
        Object.keys(idb).sort(),
        ['del', 'get', 'keys', 'put', 'tx'],
        'and the five calls kv-files.ts asks of a kv',
      );
      await assert.rejects(
        () => idb.get('k'),
        /IndexedDB is not available/,
        'a call says so when it is not',
      );
      assert.ok(reached > 0, 'and it is reached only when called');
    } finally {
      if (hadIdb) Object.defineProperty(globalThis, 'indexedDB', hadIdb);
      else delete globalThis.indexedDB;
    }
    const idbSrc = fs.readFileSync(rootUrl('src/hosts/web/idb.ts'), 'utf8');
    assert.match(
      idbSrc,
      /IDBKeyRange\.bound\(prefix, prefix \+ '\\uffff'\)/,
      'a prefix is a key range',
    );
    assert.match(
      idbSrc,
      /oncomplete/,
      'a write is answered when it is committed, not when it is asked',
    );
  });
});
