import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import type { Kv } from '../../src/hosts/web/kv-files.js';
import { serveRpc } from '../../src/rpc/serve.js';
import type { Session } from '../../src/contract/seam.js';
import type { WebBackend, Connection } from '../../src/hosts/web/backend.js';
import { rootUrl } from '../../src/hosts/node/root.js';
import { pageJs as appJs, pageHtml, pageCss, settingsTsx, memoryKv, until } from '../support.js';

// The web app's reader: a worker per origin, and a permission the user can take back.
// The pieces of W2 end to end, over in-process ports, with folders that are fakes of what the File
// System Access API hands out and a Map where IndexedDB will be. What no test here can say is
// whether a browser behaves as the fakes do: whether a `SharedWorker` can call `getFile()` and
// `queryPermission()`, and what a handle throws once the grant is revoked, are the two checks
// left to a person with a browser. (docs/architecture.md, The web app's reader)
test('the web app\'s reader: a worker per origin, and a permission the user can take back', async (t) => {
  let newStores, ports;
  const { createWebHost } = await import('../../src/hosts/web/worker.js');
  const { createWebBackend } = await import('../../src/hosts/web/backend.js');
  const { createHandles, parseWebPath, webPath } = await import('../../src/hosts/web/handles.js');
  const { createWebPlatform } = await import('../../src/hosts/web/platform.js');
  const { createReader } = await import('../../src/reader/reader.js');
  const refusal = (name) => Object.assign(new Error(name), { name });
  const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
  // A promise that rejects and is not handled would only be a warning in a browser's console and
  // a crash here, and either way it is the failure #35 is about: so every one is written down.
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  /** A folder as the File System Access API shapes one, with a permission a test can move. */
  const folder = (name, files) => {
    const h = {
      kind: 'directory',
      name,
      state: 'granted',
      allow: true, // what the user says when asked
      asked: 0,
      reads: 0,
      mtime: 1000,
      files: { ...files },
      queryPermission: async () => h.state,
      requestPermission: async () => {
        h.asked++;
        if (h.allow) h.state = 'granted';
        return h.state;
      },
      isSameEntry: async (other) => other === h,
      getDirectoryHandle: async () => {
        throw refusal('NotFoundError');
      },
      getFileHandle: async (n) => {
        if (!Object.hasOwn(h.files, n)) throw refusal('NotFoundError');
        return {
          kind: 'file',
          name: n,
          getFile: async () => {
            // What a handle does once the grant has gone, and the whole of what #35 turns on.
            if (h.state !== 'granted') throw refusal('NotAllowedError');
            h.reads++;
            return { text: async () => h.files[n], lastModified: h.mtime };
          },
        };
      },
    };
    return h;
  };
  const edit = (h, n, text) => {
    h.files[n] = text;
    h.mtime += 1000;
  };
  interface FakePort {
    onmessage: ((e: { data: unknown }) => void) | null;
    peer: FakePort | null;
    closed: boolean;
    postMessage(data: any): void;
    close(): void;
  }

  await t.test('serveRpc tells the host when a page says bye, after its watch has stopped', async () => {
    process.on('unhandledRejection', onUnhandled);

    // IndexedDB keeps a handle by cloning it, which a fake cannot be cloned to do, so the two
    // stores that hold handles do not clone. The third is the real shape of one.
    // No `tx`: the two stores that hold handles are only ever read and written a key at a time, so
    // the `Kv` they are handed as has a member that nothing calls on them.
    const plainKv = () => {
      const m = new Map();
      return {
        m,
        get: async (k) => m.get(k),
        put: async (k, v) => void m.set(k, v),
        del: async (k) => void m.delete(k),
        keys: async (prefix) => [...m.keys()].filter((k) => k.startsWith(prefix)).sort(),
      } as Kv & { m: Map<any, any> };
    };
    newStores = () => ({ files: memoryKv(), roots: plainKv(), opened: plainKv() });
    // A pair of ports that deliver what is posted, a turn later and in order, like a MessageChannel.
    // Everything is cloned on the way, as it would be, except the handle and the file a page hands
    // over: those are cloned by the browser, and a fake is not something a clone can be made of.
    ports = (): [FakePort, FakePort] => {
      // The two methods are added in the loop below, once there are two ends to point at each other.
      const end = () => ({ onmessage: null, peer: null, closed: false }) as FakePort;
      const [a, b] = [end(), end()];
      a.peer = b;
      b.peer = a;
      for (const me of [a, b]) {
        me.postMessage = (data) => {
          const raw = data?.t === 'call' && /^add(Root|Drop)$/.test(data.m);
          const sent = raw ? data : structuredClone(data);
          setImmediate(() => !me.peer.closed && me.peer.onmessage?.({ data: sent }));
        };
        me.close = () => {
          me.closed = me.peer.closed = true;
        };
      }
      return [a, b];
    };

    // serveRpc: `bye`.
    {
      const log = [];
      let hear;
      const stop = serveRpc({
        session: { watch: () => () => log.push('unwatch') } as unknown as Session,
        post: () => {},
        onMessage: (handler) => {
          hear = handler;
        },
        onHello: (doc) => log.push(`hello ${doc}`),
        onBye: () => log.push('bye'),
      });
      hear({ t: 'hello', doc: 'abc' });
      hear({ t: 'call', id: 1, m: 'watch', a: ['abc'] });
      await settle(5);
      hear({ t: 'ping' });
      hear({ t: 'bye' });
      assert.deepStrictEqual(
        log,
        ['hello abc', 'unwatch', 'bye'],
        'bye stops the watch and then tells the host; a ping is neither',
      );
      stop();
      assert.deepStrictEqual(log.slice(3), [], 'closing the connection is not a bye');
      // Without it, as every host before this one is served.
      const quiet = serveRpc({
        session: {} as Session,
        post: () => {},
        onMessage: (h) => h({ t: 'bye' }),
      });
      quiet();
      console.log('✓ serveRpc tells the host when a page says bye, after its watch has stopped');
    }
  });

  // The reader's poll: a file it may no longer read.
  await t.test('a poll that cannot read the file says so once, and says when it can again', async () => {
    const dir = folder('notes', { 'a.md': '# A\n\nOne.\n' });
    const platform = createWebPlatform({
      kv: memoryKv(),
      root: async (id) => (id === 'r1' ? dir : null),
      drops: new Map(),
    });
    const reader = await createReader({ platform, pollMs: 30 });
    const id = await reader.retain('web:r1/a.md');
    const heard = [];
    reader.subscribe(id, (e) => heard.push(e));
    await settle(120);
    assert.deepStrictEqual(heard, [], 'a file that can be read says nothing');

    dir.state = 'prompt';
                          // the grant goes
    await until(() => heard.length, 'the poll to say it cannot read');
    await settle(150);
                       // several more polls, which have nothing new to say
    assert.deepStrictEqual(
      heard.map((e) => [e.type, e.name]),
      [['unreadable', 'NotAllowedError']],
      'a poll refused by the browser says so, once, with the reason',
    );

    dir.state = 'granted';
    await until(() => heard.length === 2, 'the poll to read again');
    assert.strictEqual(heard[1].type, 'readable', 'and says when it can read again');
    edit(dir, 'a.md', '# A\n\nTwo.\n');
    await until(() => heard.some((e) => e.type === 'change'), 'the edit after the grant');
    assert.deepStrictEqual(unhandled, [], 'and none of it was a rejection nobody handled');
    reader.closeAll();
  });

  // handles.ts.
  await t.test('the handle registry: one root per folder, what may be read, what an id was', async () => {
    const stores = newStores();
    let n = 0;
    const handles = createHandles({
      roots: stores.roots,
      opened: stores.opened,
      randomId: () => `root-${++n}`,
    });
    const docs = folder('docs', { 'a.md': '# A\n' });
    const other = folder('other', {});

    const [first, again] = await Promise.all([handles.addRoot(docs), handles.addRoot(docs)]);
    assert.deepStrictEqual(
      [first, again],
      [
        { rootId: 'root-1', name: 'docs', kind: 'directory' },
        { rootId: 'root-1', name: 'docs', kind: 'directory' },
      ],
      'the same folder granted twice, even at once, is one root',
    );
    assert.strictEqual((await handles.addRoot(other)).rootId, 'root-2', 'another is another');
    assert.strictEqual(stores.roots.m.size, 2, 'and two are stored');

    assert.strictEqual(await handles.permission('root-1'), 'granted', 'a root says what it may');
    docs.state = 'prompt';
    assert.strictEqual(await handles.permission('root-1'), 'prompt', 'and says when that changes');
    assert.strictEqual(await handles.permission('nope'), 'gone', 'a root it never had is gone');
    docs.queryPermission = async () => {
      throw refusal('InvalidStateError');
    };
    assert.strictEqual(
      await handles.permission('root-1'),
      'gone',
      'so is one that cannot be asked',
    );

    await handles.rememberOpened('abc123', 'root-1', 'sub/a.md');
    assert.deepStrictEqual(
      await handles.openedAs('abc123'),
      { rootId: 'root-1', rel: 'sub/a.md' },
      'what a doc id was is remembered',
    );
    assert.strictEqual(await handles.openedAs('zzz'), null, 'and one that was never opened is not');
    assert.strictEqual(await handles.lastOpened(), null, 'with nothing shown yet there is no last');
    await handles.rememberLast('abc123');
    assert.strictEqual(await handles.lastOpened(), 'abc123', 'the last document shown is kept');
    assert.strictEqual(await handles.openedAs('last'), null, 'in a key that no doc id can be');

    assert.deepStrictEqual(parseWebPath(webPath('r', 'a/b.md')), { rootId: 'r', rel: 'a/b.md' });
    assert.strictEqual(parseWebPath('drop:x.md'), null, 'only a web: path has a root');
    assert.strictEqual(parseWebPath('/etc/passwd'), null, 'and no other kind has');

    assert.deepStrictEqual(
      handles.label('web:root-1/sub/a.md'),
      { pathLabel: 'docs/sub/a.md', dirLabel: 'docs/sub' },
      'a file in a folder is labelled as part of it',
    );
    assert.deepStrictEqual(
      handles.label('web:root-1/a.md'),
      { pathLabel: 'docs/a.md', dirLabel: 'docs' },
      'and one at its top by the folder alone',
    );
    assert.deepStrictEqual(
      handles.label('drop:d.md'),
      { pathLabel: 'drop: d.md', dirLabel: 'drop:' },
      'a drop says what it is',
    );
  });

  // The worker, and the pages of a browser.
  let stores, notes, startHost, pages: FakeWindow[], openPage, root, a;
  const clock = { t: 0 };
  const hosts = [];
  // What `addDrop` takes. The drops here are plain objects with the members the reader reads, and
  // some with fewer, to be refused: a `File` is not something a test can make by hand.
  type DropFile = Parameters<WebBackend['addDrop']>[0];
  /** A tab, as `openPage` builds it: `backend`, `watch` and `fire` are added once it exists. */
  interface FakeWindow {
    id: string | null;
    win: EventTarget;
    port: FakePort;
    live: Array<{ on: boolean; why?: string }>;
    events: any[];
    asked: Array<{ name: string }>;
    backend: WebBackend;
    watch: () => ReturnType<WebBackend['watch']>;
    fire: (type: string, init?: object) => boolean;
  }
  const rejection = (p, name) =>
    assert.rejects(p, (err: Error) => err.name === name, `rejects with ${name}`);

  await t.test('a worker holds a tab\'s document from hello to bye or silence, and reloads it', async () => {
    stores = newStores();
    notes = folder('notes', {
      'a.md': '# A\n\nOne.\n',
      'b.md': '# B\n\nBee.\n',
    });
    startHost = () => {
      const host = createWebHost({
        stores,
        pollMs: 30,
        silentMs: 1000,
        sweepMs: 10,
        now: () => clock.t,
      });
      hosts.push(host);
      return host;
    };
    pages = [];
    /**
     * A tab: a backend on its own port into `host`, which shows whatever `shows` is. `kv` is what
     * the page reads, which is the host's stores; a host on stores of its own needs them passed.
     */
    openPage = async (host, shows = null, kv = stores) => {
      const [mine, theirs] = ports();
      host.connect(theirs);
      const page = {
        id: shows,
        win: new EventTarget(),
        port: mine,
        live: [],
        events: [],
        asked: [],
      } as FakeWindow;
      page.backend = await createWebBackend({
        docId: () => page.id,
        connect: async () => ({ port: mine as unknown as Connection['port'], onError() {} }),
        stores: { roots: kv.roots, opened: kv.opened },
        win: page.win as unknown as typeof globalThis,
        pingMs: 60_000,
      });
      page.backend.onNeedsPermission((who) => page.asked.push(who));
      page.watch = () =>
        page.backend.watch({
          onLive: (on, why) => page.live.push({ on, why }),
          onEvent: (e) => page.events.push(e),
        });
      page.fire = (type, init = {}) => page.win.dispatchEvent(Object.assign(new Event(type), init));
      pages.push(page);
      return page;
    };

    const host1 = startHost();
    const reader1 = await host1.reader;
    const tab1 = await openPage(host1);

    // A page with nothing to show is told so, and not shown somebody else's file.
    await rejection(tab1.backend.doc(), 'NoDocument');

    root = await tab1.backend.addRoot(notes);
    assert.deepStrictEqual(
      [root.name, root.kind, typeof root.rootId],
      ['notes', 'directory', 'string'],
      'a folder handed over comes back with the id it is known by',
    );
    assert.strictEqual(
      (await tab1.backend.addRoot(notes)).rootId,
      root.rootId,
      'and handed over again, the same one',
    );
    await rejection(tab1.backend.addRoot({ name: 'x' }), 'BadRequest');

    a = await tab1.backend.open(`web:${root.rootId}/a.md`);
    tab1.id = a.id;
    assert.strictEqual(a.path, `web:${root.rootId}/a.md`, 'open answers the path it opened');
    assert.deepStrictEqual(
      await stores.opened.get(a.id),
      { rootId: root.rootId, rel: 'a.md' },
      'and remembers what the id means, for the reload',
    );
    const docA = await tab1.backend.doc();
    assert.strictEqual(docA.id, a.id, 'the document is the one that was opened');
    assert.match(docA.pathLabel, /^notes\/a\.md$/, 'and is labelled by its folder');
    assert.strictEqual(docA.caps.git, false, 'and says what the web reader lacks');

    // A second tab opens another file: the first is not taken along with it.
    const tab2 = await openPage(host1);
    const b = await tab2.backend.open(`web:${root.rootId}/b.md`);
    tab2.id = b.id;
    assert.notStrictEqual(b.id, a.id, 'another file is another document');
    assert.strictEqual(
      (await tab1.backend.doc()).id,
      a.id,
      'a tab keeps its document when another opens one',
    );
    assert.strictEqual((await tab2.backend.doc()).id, b.id, 'and each has its own');
    tab1.id = b.id;
    await rejection(tab1.backend.doc(), 'Closed');
    tab1.id = null;
    assert.strictEqual(
      (await tab1.backend.doc()).id,
      a.id,
      'a call that names no document is answered with the tab\'s own, never the first open',
    );
    tab1.id = a.id;

    // What a page may open: what it was given, and nothing else.
    await rejection(tab1.backend.open('/redline/objects/x.md'), 'BadRequest');
    await rejection(tab1.backend.open('/etc/hosts'), 'BadRequest');
    await rejection(tab1.backend.open(''), 'BadRequest');
    assert.ok(await tab1.backend.open(`web:${root.rootId}/nope.md`).then(() => false, () => true));
    assert.strictEqual(
      (await tab1.backend.doc()).id,
      a.id,
      'a file that will not open leaves the page on the one it had',
    );

    // Hello and bye.
    const tab3 = await openPage(host1, a.id);
                                              // a reload of a document the worker has open
    assert.strictEqual(
      (await tab3.backend.doc()).id,
      a.id,
      'a page that says hello joins the document',
    );
    tab3.fire('pagehide');
    await settle(30);
    assert.ok(reader1.pathOf(a.id), 'a bye lets go of what that page held, not what another does');
    tab1.fire('pagehide');
    await until(() => reader1.pathOf(a.id) === null, 'the last holder to let go');
    assert.ok(reader1.pathOf(b.id), 'and a tab that is still there keeps its own');
    tab1.fire('pageshow', { persisted: false });
    await settle(30);
    assert.strictEqual(
      reader1.pathOf(a.id),
      null,
      'a page shown for the first time has said hello already',
    );

    tab1.watch();
    await until(() => tab1.live.length, 'the watch to be subscribed');
    tab1.fire('pageshow', { persisted: true });
    await until(() => reader1.pathOf(a.id), 'a page back from the cache to be held again');
    await until(() => tab1.events.some((e) => e.type === 'change'), 'it to be told to look again');
    edit(notes, 'a.md', '# A\n\nTwo.\n');
    const before = tab1.events.length;
    await until(() => tab1.events.length > before, 'the watch to follow the file after a restore');
    assert.match(
      (await tab1.backend.doc()).text,
      /Two\./,
      'and the document is what is on disk now',
    );

    // Silence.
    clock.t += 500;
    tab1.port.postMessage({ t: 'ping' });
    clock.t += 600;
                    // 1100 ms since the start, 600 since the ping
    await settle(60);
    assert.ok(reader1.pathOf(a.id), 'a page that pinged lately is still held');
    clock.t += 5000;
    await until(() => reader1.pathOf(a.id) === null, 'a silent page to be let go of');
    assert.strictEqual(reader1.pathOf(b.id), null, 'as is every other that has said nothing');
    const seenBefore = tab1.events.length;
    tab1.port.postMessage({ t: 'ping' });
                                          // a tab whose timers were held back, back at last
    await until(() => reader1.pathOf(a.id), 'the next thing it says to hold its document again');
    await until(() => tab1.events.length > seenBefore, 'and to be told to look again');
    assert.strictEqual((await tab1.backend.doc()).id, a.id, 'and it is answered as before');
    tab2.port.postMessage({ t: 'ping' });
    await until(() => reader1.pathOf(b.id), 'the other tab, the same way');
    tab1.fire('pagehide');

    // A reload: what the worker finds when the id is all it has.
    // The first worker is gone and a new one starts over the same stores. Only `opened` knows what
    // the id was, and only the handle in `roots` can say whether it may be read.
    for (const p of pages) p.backend.close();
    host1.close();
    const host2 = startHost();
    const reader2 = await host2.reader;
    const open = await openPage(host2, a.id);
    const docAgain = await open.backend.doc();
    assert.strictEqual(docAgain.id, a.id, 'a granted folder opens the document the id names');
    assert.ok(docAgain.history?.length >= 1, 'with the history the store already had');
    assert.ok(reader2.pathOf(a.id), 'and holds it');

    const later = await openPage(host2, a.id);
                                               // a second tab on the same reload
    assert.strictEqual((await later.backend.doc()).id, a.id,
      'a second tab joins the open document');

    notes.state = 'prompt';
    const asking = await openPage(host2, b.id);
    await rejection(asking.backend.doc(), 'NeedsPermission');
    assert.deepStrictEqual(asking.asked, [{ name: 'notes' }],
      'a folder to ask for again says which');
    assert.strictEqual(notes.asked, 0, 'and nothing has asked the user yet');
    asking.watch();
    await until(() => asking.live.length >= 2, 'the watch to say what it waits for');
    assert.deepStrictEqual(
      asking.live.map((l) => l.on),
      [true, false],
      'a watch begun while the document waits is subscribed, and then says it is not live',
    );
    assert.match(asking.live.at(-1).why, /permission/i, 'and what it is waiting for');
    notes.allow = false;
    assert.strictEqual(await asking.backend.reopen(), false, 'a user who says no is not a grant');
    await rejection(asking.backend.doc(), 'NeedsPermission');
    notes.allow = true;
    assert.strictEqual(await asking.backend.reopen(), true, 'one who says yes is');
    assert.strictEqual(notes.asked, 2, 'the page asked, each time from its own click');
    assert.strictEqual((await asking.backend.doc()).id, b.id, 'and the document is there after it');

    // The same id on a worker that has nothing open: only `opened` and `roots` say what it is.
    notes.state = 'denied';
    const hostD = startHost();
    await rejection((await openPage(hostD, a.id)).backend.doc(), 'NoDocument');
    assert.strictEqual(notes.asked, 2, 'a folder that was denied is not asked again');
    notes.state = 'granted';
    const roots = new Map(stores.roots.m);
    await stores.roots.del(root.rootId);
    const hostG = startHost();
    await rejection((await openPage(hostG, a.id)).backend.doc(), 'NoDocument');
    await rejection((await openPage(hostG, 'eeeeeeeeeeee')).backend.doc(), 'NoDocument');
    for (const [k, v] of roots) await stores.roots.put(k, v);
  });

  // #35: a permission taken back mid-session.
  await t.test('a permission taken back mid-session: not live, then a grant makes it live', async () => {
    await stores.roots.put(root.rootId, { handle: notes, name: 'notes', kind: 'directory' });
    notes.state = 'granted';
    const host3 = startHost();
    const watcher = await openPage(host3, a.id);
    await watcher.backend.doc();
    watcher.watch();
    await until(() => watcher.live.some((l) => l.on), 'the watch to be live');
    watcher.live.length = 0;
    watcher.asked.length = 0;

    notes.state = 'prompt';
                            // the grant goes; the next read throws NotAllowedError
    await until(() => watcher.live.some((l) => !l.on), 'the watcher to hear it is not live');
    assert.match(watcher.live[0].why, /permission/i, 'and why');
    assert.deepStrictEqual(watcher.asked, [{ name: 'notes' }], 'and what to ask the user for');
    await settle(120);
    assert.strictEqual(watcher.live.length, 1, 'once, and not on every poll after it');
    await rejection(watcher.backend.doc(), 'NeedsPermission');

    const reads = notes.reads;
    assert.strictEqual(await watcher.backend.reopen(), true, 'the user says yes');
    await until(() => watcher.live.at(-1)?.on === true, 'the watcher to go live again');
    edit(notes, 'a.md', '# A\n\nThree.\n');
    const seen = watcher.events.length;
    await until(() => watcher.events.length > seen, 'a change after the grant');
    assert.ok(notes.reads > reads, 'it is reading the file again');
    assert.deepStrictEqual(unhandled, [], 'nothing was left unhandled');
  });

  // A reader that cannot be built.
  await t.test('a worker with no reader tells every watch, and leaves no rejection', async () => {
    const broken = createWebHost({
      stores: newStores(),
      pollMs: 30,
      // Building the reader cannot fail over the web platform, so the failure is put there.
      makeReader: async () => {
        throw new Error('the reader could not be built');
      },
    });
    hosts.push(broken);
    const page = await openPage(broken, 'bbbbbbbbbbbb');
    await assert.rejects(page.backend.doc(), /could not be built/, 'a call says why it failed');
    page.watch();
    await until(() => page.live.length >= 2, 'the watch to say it is not live');
    assert.deepStrictEqual(
      page.live.map((l) => l.on),
      [true, false],
      'a watch on a worker with no reader is subscribed, and then says it is not live',
    );
    assert.match(page.live.at(-1).why, /could not be built/, 'and why');
    await settle(60);
    assert.deepStrictEqual(unhandled, [], 'and no watch was left as a rejection nobody handled');
  });

  // A folder denied under a page that is showing it.
  await t.test('a denied folder lets go of its document; one to ask again does not', async () => {
    notes.state = 'granted';
    const host5 = startHost();
    const reader5 = await host5.reader;
    const page = await openPage(host5, a.id);
    assert.strictEqual((await page.backend.doc()).id, a.id, 'a document from a granted folder');

    notes.state = 'prompt';
    await rejection(page.backend.doc(), 'NeedsPermission');
    assert.ok(reader5.pathOf(a.id), 'a folder that can be asked for again keeps the document held');

    notes.state = 'denied';
    await rejection(page.backend.doc(), 'NoDocument');
    assert.strictEqual(
      reader5.pathOf(a.id),
      null,
      'one that was denied lets go of it, so nothing polls a file the page no longer shows',
    );
    await rejection(page.backend.doc(), 'NoDocument');
    notes.state = 'granted';
  });

  // A link into a folder whose grant has lapsed.
  await t.test('a link into a folder that must be asked for again says which folder to ask', async () => {
    const archive = folder('archive', { 'x.md': '# X\n\nEx.\n' });
    archive.state = 'prompt';
    const host6 = startHost();
    const reader6 = await host6.reader;
    const page = await openPage(host6);
    const arch = await page.backend.addRoot(archive);
    const here = await page.backend.open(`web:${root.rootId}/a.md`);
    page.id = here.id;

    const notesAsked = notes.asked;
                                    // what earlier tests asked, which is not this test's
    notes.state = 'prompt';
    await rejection(page.backend.open(`web:${root.rootId}/b.md`), 'NeedsPermission');
    assert.deepStrictEqual(page.asked, [{ name: 'notes' }], 'a lapsed folder is asked for by name');
    assert.ok(reader6.pathOf(here.id), 'and the page is left on the document it had');
    assert.strictEqual(notes.asked, notesAsked, 'with nobody asked yet');

    // The link is into another folder than the one on screen, and the button has to say which.
    page.asked.length = 0;
    await rejection(page.backend.open(`web:${arch.rootId}/x.md`), 'NeedsPermission');
    assert.deepStrictEqual(page.asked, [{ name: 'archive' }], 'the folder the link was into');
    assert.strictEqual(await page.backend.reopen(), true, 'and asking is for that one');
    assert.deepStrictEqual(
      [archive.asked, notes.asked - notesAsked],
      [1, 0],
      'not the one on screen',
    );
    const x = await page.backend.open(`web:${arch.rootId}/x.md`);
    assert.strictEqual(reader6.pathOf(x.id), `web:${arch.rootId}/x.md`, 'which then opens');

    // Not a permission: a file that is not there is still only an error.
    await assert.rejects(page.backend.open(`web:${arch.rootId}/nope.md`), (err: Error) => {
      return err.name !== 'NeedsPermission';
    });
    notes.state = 'granted';
    assert.deepStrictEqual(unhandled, [], 'nothing was left unhandled');
  });

  // A file with no handle.
  await t.test('a dropped file opens as a document of its own, and a drop again replaces it', async () => {
    const host4 = startHost();
    const dropper = await openPage(host4);
    let text = '# Dropped\n\nFirst.\n';
    const file = { name: 'd.md', text: async () => text, lastModified: 1 };
    const p = await dropper.backend.addDrop(file as unknown as DropFile);
    assert.strictEqual(p, 'drop:d.md', 'a drop is a path of its own');
    const sneaky = { name: '../d.md', text: async () => '' };
    await rejection(dropper.backend.addDrop(sneaky as unknown as DropFile), 'BadRequest');
    await rejection(dropper.backend.addDrop({ name: 'd.md' } as unknown as DropFile), 'BadRequest');
    const opened = await dropper.backend.open(p);
    dropper.id = opened.id;
    const dropped = await dropper.backend.doc();
    assert.strictEqual(dropped.pathLabel, 'drop: d.md', 'and says it is one');
    assert.strictEqual(await stores.opened.get(opened.id), undefined, 'it is not remembered');
    dropper.watch();
    await until(() => dropper.live.some((l) => l.on), 'the watch to be live');
    // Dropped again, the file changed: the same name, so the same document, and a change to follow.
    text = '# Dropped\n\nSecond.\n';
    const again = { ...file, text: async () => text, lastModified: 2 };
    const next = await dropper.backend.addDrop(again as unknown as DropFile);
    assert.strictEqual(next, p, 'the same name replaces what was dropped');
    await until(() => dropper.events.some((e) => e.type === 'change'), 'the new file to be read');
  });

  // A visit with no `?id=`: the document a tab last showed.
  // The app's bare address -- a bookmark, a new tab -- comes back to where the user was, as a
  // reopened app does, and not to the welcome every time. On stores of its own, so that which
  // document is the last is this test's and not the sum of every test above.
  await t.test('a page with no id is given the last document a tab showed, if it can be read', async () => {
    const own = newStores();
    const hostOn = () => {
      const host = createWebHost({
        stores: own,
        pollMs: 30,
        silentMs: 1000,
        sweepMs: 10,
        now: () => clock.t,
      });
      hosts.push(host);
      return host;
    };
    const desk = folder('desk', { 'one.md': '# One\n\nFirst.\n', 'two.md': '# Two\n\nSecond.\n' });
    const hostL = hostOn();
    const readerL = await hostL.reader;

    const first = await openPage(hostL, null, own);
    await rejection(first.backend.doc(), 'NoDocument');
                                                        // nothing was ever shown: the welcome
    const dr = await first.backend.addRoot(desk);
    const one = await first.backend.open(`web:${dr.rootId}/one.md`);
    first.id = one.id;
    assert.strictEqual(await own.opened.get('last'), one.id, 'a file opened is the last shown');

    const bare = await openPage(hostL, null, own);
    const resumed = await bare.backend.doc();
    assert.strictEqual(resumed.id, one.id, 'a page that names none is given the last one');
    assert.match(resumed.text, /First\./, 'with its text');
    bare.id = resumed.id;
                          // what the page's `adopt` does with the id it was given
    const two = await bare.backend.open(`web:${dr.rootId}/two.md`);
    bare.id = two.id;
    assert.strictEqual(await own.opened.get('last'), two.id, 'and the next one opened is');
    assert.strictEqual((await first.backend.doc()).id, one.id, 'which takes no tab along with it');

    // A drop is gone with the worker that had it: never the last, so the one before it stays.
    const dropper = await openPage(hostL, null, own);
    assert.strictEqual((await dropper.backend.doc()).id, two.id, 'a third bare page is given two');
    const loose = { name: 'loose.md', text: async () => '# Loose\n', lastModified: 1 } as DropFile;
    dropper.id = (await dropper.backend.open(await dropper.backend.addDrop(loose))).id;
    assert.strictEqual(await own.opened.get('last'), two.id, 'a drop is not the last');

    // A tab in the background, let go of for its silence and taken back: not the user going
    // anywhere, so it does not take `last` back from the tab in front.
    clock.t += 5000;
    await until(() => readerL.pathOf(one.id) === null, 'the quiet tabs to be let go of');
    first.port.postMessage({ t: 'ping' });
    await until(() => readerL.pathOf(one.id), 'the tab on one to be taken back');
    assert.strictEqual((await first.backend.doc()).id, one.id, 'on the document it had');
    assert.strictEqual(await own.opened.get('last'), two.id, 'and the last is still two');

    // A reload on a document is the user going back to it.
    const reload = await openPage(hostL, one.id, own);
    await reload.backend.doc();
    assert.strictEqual(await own.opened.get('last'), one.id, 'a reload on one makes it last');
    for (const p of [first, bare, dropper, reload]) p.backend.close();
    hostL.close();

    // The browser started again: a worker with nothing open, and the stores.
    const fresh = await openPage(hostOn(), null, own);
    assert.strictEqual((await fresh.backend.doc()).id, one.id, 'a new worker finds the last one');

    desk.state = 'prompt';
    const asking = await openPage(hostOn(), null, own);
    await rejection(asking.backend.doc(), 'NeedsPermission');
    assert.deepStrictEqual(asking.asked, [{ name: 'desk' }], 'a lapsed folder is asked for');
    assert.strictEqual(await asking.backend.reopen(), true, 'from the page, which names no id');
    assert.strictEqual((await asking.backend.doc()).id, one.id, 'and the last one is there after');

    desk.state = 'denied';
    await rejection((await openPage(hostOn(), null, own)).backend.doc(), 'NoDocument');
    assert.strictEqual(desk.asked, 1, 'a denied folder is not asked for: the welcome');
    desk.state = 'granted';
    await own.roots.del(dr.rootId);
    await rejection((await openPage(hostOn(), null, own)).backend.doc(), 'NoDocument');
    await rejection((await openPage(hostOn(), 'last', own)).backend.doc(), 'NoDocument');
    assert.deepStrictEqual(unhandled, [], 'nothing was left unhandled');
  });

  // W3: the welcome.
  // The page's empty state, driven through the real backend and the real worker. What stands in
  // for the browser is a DOM of only what the welcome touches, file handles, and the pickers.
  // Whether a real `showOpenFilePicker`, a real drop or a real `navigator.storage.persist()`
  // behaves as these do is for a person with a browser. (docs/web-app.md, Opening something)
  await t.test('the web app keeps the files a tab has open, per tab, and what was closed', async (t) => {
    let fileOf, grantable, mount, single, hostW;
    const welcomeTsx = fs.readFileSync(rootUrl('public/app/ui/Welcome.tsx'), 'utf8');
    const { LINK_NOTE } = await import('../../src/hosts/web/backend.js');
    // A file handle, and what is added to it after it is made: `isSameEntry` by `fileOf`, the rest
    // by `grantable`.
    interface FakeHandle {
      kind: string;
      name: string;
      queryPermission: () => Promise<string>;
      getFile: () => Promise<{ name: string; text: () => Promise<string>; lastModified: number }>;
      isSameEntry?: (other: unknown) => Promise<boolean>;
      requestPermission?: () => Promise<string>;
      state?: string;
      allow?: boolean;
      asked?: number;
    }
    // A folder, as a drop with a handle gives one. The welcome is not to read it, only to see it is
    // a folder, so it has nothing in it to read.
    const folderOf = (name) => ({ kind: 'directory', name, isSameEntry: async () => false });
    const NOT_A_FOLDER = /opens files, not folders/;
    // The welcome, through the real backend and worker.
    // Its doors, without the page: what it says arrives as a view, which ui/Welcome.tsx draws and
    // which is read here instead. The DOM it still touches is the class list on <html>, for a drag.
    const fakeDoc = () => {
      const classes = new Set();
      return {
        classes,
        documentElement: {
          classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
        },
      };
    };
    const dropOf = (page, items, files = [], types = ['Files']) => {
      const e = Object.assign(new Event('drop', { cancelable: true }), {
        dataTransfer: { types, items, files },
      });
      page.win.dispatchEvent(e);
      return e;
    };
    const dragOf = (page, type, types = ['Files']) => {
      const e = Object.assign(new Event(type, { cancelable: true }), { dataTransfer: { types } });
      page.win.dispatchEvent(e);
      return e;
    };
    const item = (give) => ({ kind: 'file', ...give });
    const copy = (n, text?) => ({ name: n, text, lastModified: 5 });

    await t.test('the welcome opens a file, offers no folder, and says what the Mac app adds', async () => {
      const { MD_LINK } = await import('../../src/core/links.js');
      // A file as a handle gives it, and readable only while it is granted.
      fileOf = (n, text, state = () => 'granted') => {
        const f: FakeHandle = {
          kind: 'file',
          name: n,
          queryPermission: async () => state(),
          getFile: async () => {
            if (state() !== 'granted') throw refusal('NotAllowedError');
            return { name: n, text: async () => text, lastModified: 1000 };
          },
        };
        f.isSameEntry = async (other) => other === f;
        return f;
      };
      /** A file whose grant a test can take away, and that asks the user when a page asks again. */
      grantable = (n, text) => {
        const f = fileOf(n, text, () => f.state);
        Object.assign(f, { state: 'granted', allow: true, asked: 0 });
        f.requestPermission = async () => {
          f.asked++;
          if (f.allow) f.state = 'granted';
          return f.state;
        };
        return f;
      };

      type Wiring = { hidden?: boolean; hooks?: object };
      /**
       * A tab showing the welcome, with `extra` as what the browser has on `window`. `shows` is the
       * `?id=` it was loaded with, which the worker is told as the page connects. `wiring` is for a
       * page that has a document on screen: `hidden` says the welcome is not showing, as `#welcome`
       * is not then, and `hooks` are the page's own, which a page without a document has no need of.
       * `seen.view` is what the page would be drawing.
       */
      mount = async (host, extra, shows = null, wiring: Wiring = {}) => {
        const page = await openPage(host, shows);
        const doc = fakeDoc();
        const calls = { opened: [], ids: [], granted: 0, persist: 0 };
        Object.assign(page.win, {
          navigator: { storage: { persist: async () => void calls.persist++ } },
          ...extra,
        });
        // What the page's `openFile` does: ask the backend, and show it if it opens.
        const open = async (path) => {
          try {
            const o = await page.backend.open(path);
            page.id = o.id;
            calls.opened.push(path);
            calls.ids.push(o.id);
            return true;
          } catch {
            return false;
          }
        };
        const granted = async () => void calls.granted++;
        const seen = { view: null, views: 0 };
        const show = (view) => {
          seen.view = view;
          seen.views++;
        };
        const showing = () => !wiring.hidden;
        const hooks = { open, granted, show, showing, doc: doc as any, ...wiring.hooks };
        return { page, doc, calls, seen, w: page.backend.welcome(hooks) };
      };

      single = fileOf('single.md', '# Single\n\nOn its own.\n');
      const behave = { file: async () => [single] };
      const picks = [];
      hostW = startHost();

      // A file: the one door.
      {
        const w = await mount(hostW, {
          // A browser that could pick a folder is not offered one: the web app opens files.
          showDirectoryPicker: async () => {
            throw new Error('the welcome picked a folder');
          },
          showOpenFilePicker: (opts) => (picks.push(opts), behave.file()),
        });
        const fileBtn = { click: () => w.w.pickFile() };
        assert.deepStrictEqual(
          w.seen.view,
          { canFile: true, busy: false, status: '', reopen: null, back: false },
          'a browser with a picker is told so as it mounts, with nothing to reopen or go back to',
        );
        assert.match(
          welcomeTsx,
          /<button type="button" class="welcome-primary" onClick=\{pickFile\}>\s*Open file…/,
          'Open file… is the way in, and the primary button',
        );
        // The drawn text, with the comments out of it, which talk about folders to say why not.
        const drawn = welcomeTsx.replace(/\{\/\*[\s\S]*?\*\/\}|\/\/.*$/gm, '');
        assert.ok(
          !/folder/i.test(drawn) &&
            !/showDirectoryPicker/.test(fs.readFileSync(rootUrl('src/hosts/web/welcome.ts'), 'utf8')),
          'and nothing offers a folder, even in a browser that could pick one',
        );
        assert.match(welcomeTsx, /<div class="welcome-reopen" hidden=\{!v\.reopen\}>/,
          'the ask to reopen is hidden until there is a file to ask for');
        assert.match(welcomeTsx, /class="welcome-secondary" hidden=\{!v\.back\} onClick=\{back\}/,
          'and Back until there is a document, and goes back to it');

        // What the web app cannot do, said before a user finds it out, with the way to what can.
        const limits = drawn.match(/<p class="welcome-hint welcome-limits">([\s\S]*?)<\/p>/)?.[1];
        assert.ok(limits, 'the limits are said, as a hint');
        assert.match(
          limits.replace(/\s+/g, ' '),
          /one file at a time: its links to other files do not open, and there is no git or PlantUML/,
          'which are the ones a reader coming from the Mac app reaches for',
        );
        assert.match(
          limits,
          /<a href=\{MAC_APP_URL\} target="_blank" rel="noopener">\s*Get the Mac app\s*<\/a>/,
          'with a link to the Mac app, in a tab of its own',
        );
        assert.match(welcomeTsx, /export const MAC_APP_URL = 'https:\/\/redline\.iamtuna\.org\/#get';/,
          "the landing's download");

        await fileBtn.click();
        const opts = picks.at(-1);
        assert.deepStrictEqual(
          [opts.excludeAcceptAllOption, opts.types[0].accept['text/markdown'].includes('.md')],
          [true, true],
          'the file picker is asked for markdown, and only for it',
        );
        assert.ok(opts.types[0].accept['text/plain'].includes('.txt'), 'and text');
        assert.match(w.calls.opened[0], /^web:[^/]+\/single\.md$/, 'a file picked is opened');
        assert.match((await w.page.backend.doc()).text, /On its own\./, 'and is the file');
        assert.strictEqual(w.calls.persist, 1, 'storage is asked to persist once a file opens');
        await fileBtn.click();
        assert.strictEqual(w.calls.opened.length, 2, 'another pick opens again');
        assert.strictEqual(w.calls.persist, 1, 'and storage is not asked again');
        assert.strictEqual(
          await w.page.backend.linkNote(w.calls.opened[0]),
          LINK_NOTE,
          'a link out of it says why it will not open',
        );
        assert.match(LINK_NOTE, /one file at a time[\s\S]*The Mac app follows them/, 'and where');
        for (const [p, why] of [
          [null, 'a page with no document'],
          ['web:nope/x.md', 'a root that is gone'],
          ['/etc/x.md', 'a path of no kind here'],
        ]) {
          assert.strictEqual(await w.page.backend.linkNote(p), null, `says nothing for ${why}`);
        }
        assert.deepStrictEqual(
          [
            ['a.md', 'A.MD', 'b.markdown', 'c.mdown', 'd.mkd', 'e.mdx', 'f.txt'].every((n) =>
              MD_LINK.test(n),
            ),
            ['g.png', 'h.md.bak', 'md', 'i.mdd'].some((n) => MD_LINK.test(n)),
          ],
          [true, false],
          'what it takes is one pattern, the one the page follows links by',
        );

        // Not a failure, and not a message.
        behave.file = async () => {
          throw refusal('AbortError');
        };
        await fileBtn.click();
        assert.strictEqual(w.seen.view.status, '', 'a picker that was cancelled says nothing');
        behave.file = async () => {
          throw refusal('SecurityError');
        };
        await fileBtn.click();
        assert.match(w.seen.view.status, /Could not open that: SecurityError/, 'but a refusal is');
        assert.match(welcomeTsx, /<p class="welcome-status" role="status" hidden=\{!v\.status\}>/,
          'where the page shows it');
        w.w.sync({});
        assert.strictEqual(w.seen.view.status, '', 'until the page says it moved on');

        // One at a time: a second click while a picker is up is not a second picker.
        let release;
        const before = picks.length;
        behave.file = () =>
          new Promise((r) => {
            release = () => r([single]);
          });
        const first = fileBtn.click();
        const second = fileBtn.click();
        assert.strictEqual(picks.length, before + 1, 'a click while one is open opens no other');
        assert.strictEqual(w.seen.view.busy, true, 'and the welcome says it is busy');
        release();
        await Promise.all([first, second]);
        assert.strictEqual(w.seen.view.busy, false, 'until it is not');

        const opened = w.calls.opened.length;
        const roots = stores.roots.m.size;
        behave.file = async () => [fileOf('logo.png', '')];
        await fileBtn.click();
        assert.match(w.seen.view.status, /Redline opens markdown/, 'a picture is refused');
        assert.deepStrictEqual(
          [w.calls.opened.length, stores.roots.m.size],
          [opened, roots],
          'before it is opened, or granted',
        );

        // What the page's Open button and ⌘O call, with a document on screen and the welcome
        // hidden: the picker inside the gesture, before anything is awaited.
        behave.file = async () => [single];
        const picked = picks.length;
        const asked = w.w.pickFile();
        assert.strictEqual(picks.length, picked + 1,
          'the page can call the picker itself, at once');
        await asked;
        assert.match(w.calls.opened.at(-1), /^web:[^/]+\/single\.md$/,
          'and it opens what is picked');
        // A signal holding the same object would not tell its readers anything had changed.
        const [last, views] = [w.seen.view, w.seen.views];
        w.w.sync({});
        assert.notStrictEqual(w.seen.view, last, 'each view handed over is a new object');
        assert.strictEqual(w.seen.views, views + 1, 'and is handed over once for each change');
        console.log('✓ the welcome opens a file, offers no folder, and says what the Mac app adds');
      }
    });

    // A drop.
    await t.test('a drop is a grant with a handle and a copy without one, and never a folder', async () => {
      const w = await mount(hostW, { showOpenFilePicker: async () => [single] });
      const dragging = () => w.doc.classes.has('dropping');
      assert.ok(dragOf(w.page, 'dragenter').defaultPrevented, 'a file dragged in is taken');
      assert.ok(dragging(), 'and the page says so');
      dragOf(w.page, 'dragenter');
      dragOf(w.page, 'dragleave');
      assert.ok(dragging(), 'across the elements it passes over');
      dragOf(w.page, 'dragleave');
      assert.ok(!dragging(), 'and says no more when it leaves');
      const text = dragOf(w.page, 'dragenter', ['text/plain']);
      assert.ok(!text.defaultPrevented && !dragging(), 'a dragged selection is not its business');

      const handled = fileOf('dropped.md', '# Dropped\n\nBy handle.\n');
      const e = dropOf(w.page, [item({ getAsFileSystemHandle: async () => handled })]);
      assert.ok(e.defaultPrevented, 'a drop is not left for the browser to open in our place');
      assert.ok(!dragging(), 'and is the end of the dragging');
      await until(() => w.calls.opened.length === 1, 'the dropped file to open');
      assert.match(w.calls.opened[0], /^web:[^/]+\/dropped\.md$/, 'a handle dropped is a grant');
      assert.strictEqual(
        await w.page.backend.linkNote(w.calls.opened[0]),
        LINK_NOTE,
        'of the file alone',
      );

      const roots = stores.roots.m.size;
      dropOf(w.page, [item({ getAsFileSystemHandle: async () => folderOf('proj') })]);
      await until(() => NOT_A_FOLDER.test(w.seen.view.status), 'a dropped folder refused');
      assert.match(w.seen.view.status, /open the folder in the Mac app/, 'with where to');
      assert.deepStrictEqual(
        [w.calls.opened.length, stores.roots.m.size],
        [1, roots],
        'a folder dropped is neither opened nor granted',
      );
      // A browser with no handles gives a folder as a `File` named for it, and only the entry
      // says it is not one: without it the user would be told the folder is not markdown.
      w.w.sync({});
      dropOf(w.page, [
        item({ webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => copy('notes') }),
      ]);
      await until(() => NOT_A_FOLDER.test(w.seen.view.status), 'a folder with no handle');
      assert.strictEqual(w.calls.opened.length, 1, 'is refused as a folder too');

      const fell = copy('fell-back.md', async () => '# Fell\n');
      dropOf(w.page, [
        item({
          getAsFileSystemHandle: async () => {
            throw refusal('NotAllowedError');
          },
          getAsFile: () => fell,
        }),
      ]);
      await until(() => w.calls.opened.length === 2, 'a drop whose handle was refused');
      assert.strictEqual(w.calls.opened[1], 'drop:fell-back.md', 'is read as a copy');
      assert.strictEqual(
        await w.page.backend.linkNote('drop:fell-back.md'),
        LINK_NOTE,
        'which says why it has no links',
      );
      dropOf(w.page, [item({ getAsFile: () => copy('plain.txt', async () => 'text\n') })], []);
      await until(() => w.calls.opened.length === 3, 'a drop from a browser with no handles');
      assert.strictEqual(w.calls.opened[2], 'drop:plain.txt', 'is the same');
      dropOf(w.page, [], [copy('old.md', async () => '# Old\n')]);
      await until(() => w.calls.opened.length === 4, 'a drop that has only a file list');
      assert.strictEqual(w.calls.opened[3], 'drop:old.md', 'is the same again');

      dropOf(w.page, [item({ getAsFile: () => copy('pic.png', async () => '') })]);
      await until(() => /Redline opens markdown/.test(w.seen.view.status), 'a refusal');
      assert.strictEqual(w.calls.opened.length, 4, 'a picture dropped opens nothing');
      assert.deepStrictEqual(unhandled, [], 'and no drop left a rejection nobody handled');
    });

    // No File System Access: a copy, and one history for a name.
    await t.test('with no file picker the welcome takes a copy, and a name is one history', async () => {
      const w = await mount(hostW, {});
      assert.strictEqual(w.w.canFile, false, 'a browser with no picker is told so');
      assert.strictEqual(w.seen.view.canFile, false, 'and so is the page');
      assert.match(
        welcomeTsx.replace(/\s+/g, ' '),
        /\{!v\.canFile && \( <p class="welcome-hint"> This browser cannot keep a link[^<]*reads a copy[^<]*same name[^<]*continues its history/,
        'which says it is a copy, and that a name is a history',
      );
      // The input is the page's: the button is it, and so is the page's own way to the picker.
      assert.match(welcomeTsx, /const pickFile = \(\) => \(doors\.canFile \? doors\.pickFile\(\) : input\.current\?\.click\(\)\);/,
        "with no picker, Open file… is the input's");
      assert.match(welcomeTsx, /\{!v\.canFile && \(\s*<input\s+ref=\{input\}\s+type="file"\s+hidden/,
        'which is not drawn');
      assert.match(welcomeTsx, /const file = field\.files\?\.\[0\];\s*field\.value = '';\s*if \(file\) doors\.openCopy\(file\);/,
        'and is emptied as it is read, so the same file can be chosen again');

      const pick = async (n, body) => {
        const before = w.calls.opened.length;
        await w.w.openCopy({ name: n, text: async () => body, lastModified: 7 } as any);
        await until(() => w.calls.opened.length > before, `${n} to open`);
      };
      await pick('snap.md', '# Snap\n\nFirst.\n');
      await pick('snap.md', '# Snap\n\nSecond.\n');
      assert.deepStrictEqual(w.calls.opened, ['drop:snap.md', 'drop:snap.md'], 'a copy, by name');
      assert.strictEqual(w.calls.ids[0], w.calls.ids[1], 'and a file of that name is one document');
      // The copy is replaced in the worker, and read by the reader in its own time.
      const now = async () => /Second\./.test((await w.page.backend.doc()).text);
      await until(now, 'what it says now');
      assert.strictEqual(w.calls.persist, 1, 'the storage request is made once here too');
    });

    // A grant that lapsed, and the ways out of the welcome.
    await t.test('the welcome asks again for a lapsed file, and offers the way back', async () => {
      const lapsed = grantable('l.md', '# L\n\nStill here.\n');
      const hostR = startHost();
      const setup = await openPage(hostR);
      const lroot = await setup.backend.addRoot(lapsed);
      const lopen = await setup.backend.open(`web:${lroot.rootId}/l.md`);
      lapsed.state = 'prompt';

      const w = await mount(hostR, {}, lopen.id);
      await rejection(w.page.backend.doc(), 'NeedsPermission');
      assert.deepStrictEqual(w.page.asked, [{ name: 'l.md' }], 'the page is told which file');
      assert.strictEqual(w.seen.view.reopen, null, 'the welcome does not ask until told to');
      w.w.sync({ reopen: 'l.md' });
      assert.strictEqual(w.seen.view.reopen, 'l.md', 'the page says so, and it asks about it');
      assert.match(welcomeTsx, /\{v\.reopen && `Redline needs your permission to read \$\{v\.reopen\} again\.`\}/,
        'by its name');
      assert.match(
        welcomeTsx,
        /onClick=\{\(\) => doors\.reopen\(\)\}>\s*\{v\.reopen && `Reopen \$\{v\.reopen\}`\}/,
        'with a button that names it, and asks',
      );
      const reopen = { click: () => w.w.reopen() };

      lapsed.allow = false;
      await reopen.click();
      assert.strictEqual(lapsed.asked, 1, 'a click asks the user');
      assert.strictEqual(w.seen.view.status, 'Redline was not given l.md.', 'who says no');
      assert.deepStrictEqual([w.calls.granted, w.calls.persist], [0, 0], 'is not a grant');
      w.w.sync({ reopen: 'l.md' });
      assert.strictEqual(w.seen.view.status, '', 'and the page moving on clears what was said');

      lapsed.allow = true;
      await reopen.click();
      assert.strictEqual(lapsed.asked, 2, 'asked again, from the next click');
      assert.deepStrictEqual([w.calls.granted, w.calls.persist], [1, 1], 'who says yes is a grant');
      assert.match((await w.page.backend.doc()).text, /Still here\./, 'and the document is back');

      w.w.sync({});
      assert.strictEqual(w.seen.view.reopen, null, 'a page with nothing to reopen hides it');
      w.w.sync({ back: true });
      assert.strictEqual(w.seen.view.back, true, 'a page with a document to go back to offers it');
      assert.deepStrictEqual(unhandled, [], 'nothing was left unhandled');
    });

    // A drop with a document on screen: the welcome is hidden, and stays so.
    await t.test('a drop on a document: a notice for a folder or a refusal, never the welcome', async () => {
      const said = [];
      const w = await mount(hostW, { showOpenFilePicker: async () => [single] }, null, {
        hidden: true,
        hooks: { notify: (text) => said.push(text) },
      });

      dropOf(w.page, [item({ getAsFileSystemHandle: async () => folderOf('proj') })]);
      await until(() => said.length === 1, 'a folder dropped on a document to be refused');
      assert.match(said[0], NOT_A_FOLDER, 'is told so by the page');
      assert.strictEqual(w.seen.view.status, '', 'and not said where it cannot be read');

      dropOf(w.page, [item({ getAsFile: () => copy('pic.png', async () => '') })]);
      await until(() => said.length === 2, 'a picture dropped on a document to be refused');
      assert.match(said[1], /Redline opens markdown/, 'is said the same way');

      const bad = async () => {
        throw refusal('NotReadableError');
      };
      dropOf(w.page, [item({ getAsFile: () => copy('unreadable.md', bad) })]);
      await until(() => said.length === 3, 'a file that will not open to be refused');
      assert.match(said[2], /^Could not open that/, 'and so is a failure');

      const before = w.calls.opened.length;
      dropOf(w.page, [item({ getAsFile: () => copy('fine.md', async () => '# Fine\n') })]);
      await until(() => w.calls.opened.length === before + 1, 'a markdown file to open');
      assert.deepStrictEqual(
        [said.length, w.seen.view.status],
        [3, ''],
        'a file that opens is just opened: no notice, and nothing for the welcome to say',
      );
      assert.deepStrictEqual(unhandled, [], 'and none of it left a rejection nobody handled');
    });

    // The open files: what the web app keeps where a window has its shell's tabs.
    await t.test('the web app keeps the files a tab has open, per tab, and what was closed', async () => {
      const { createOpenFiles, storageOf, OPEN_KEY } = await import(
        '../../src/hosts/web/open-files.js'
      );
      // The two calls open-files makes of a Storage, and the Map behind them for a test to read.
      const store = () => {
        const m = new Map();
        return {
          m,
          getItem: (k) => (m.has(k) ? m.get(k) : null),
          setItem: (k, v) => void m.set(k, String(v)),
        } as unknown as Storage & { m: Map<string, string> };
      };
      const entry = (id, rel) => ({
        id,
        path: `web:r/${rel}`,
        name: rel.split('/').pop(),
        dir: 'shelf',
        label: `shelf/${rel}`,
      });
      const shared = store();
      const tabA = store();
      const a = createOpenFiles({ tab: tabA, shared });
      assert.deepStrictEqual(
        [a.list(), a.closedAll()],
        [[], false],
        'a first visit has nothing open, and has not closed everything either',
      );
      assert.ok(a.note(entry('1', 'a.md')) && a.note(entry('2', 'b.md')), 'files join the list');
      assert.ok(a.note(entry('3', 'c.md')), 'in the order they were opened');
      assert.strictEqual(a.note(entry('1', 'a.md')), false, 'one open already is not added twice');
      assert.ok(
        a.note({ ...entry('1', 'a.md'), dir: 'shelf2', label: 'shelf2/a.md' }),
        'but is relabelled, in place',
      );
      assert.deepStrictEqual(
        a.list().map((t) => [t.id, t.dir]),
        [['1', 'shelf2'], ['2', 'shelf'], ['3', 'shelf']],
        'so the list is what was opened, in order, each once',
      );
      a.list()[0].name = 'scribbled';
      assert.strictEqual(a.list()[0].name, 'a.md', 'and what it hands out is a copy');

      const again = createOpenFiles({ tab: tabA, shared });
      assert.deepStrictEqual(again.list(), a.list(), 'a reload of the tab has its list back');
      const tabB = store();
      const b = createOpenFiles({ tab: tabB, shared });
      assert.deepStrictEqual(
        b.list(),
        a.list(),
        'a tab with none of its own starts from the last list any tab kept, as a bare visit does',
      );
      b.note(entry('4', 'd.md'));
      assert.strictEqual(
        createOpenFiles({ tab: tabA, shared }).list().length,
        3,
        'and after that each tab keeps its own',
      );

      assert.strictEqual(a.close('2').id, '3', 'closing one goes to the file after it');
      assert.strictEqual(a.close('3').id, '1', 'or, closing the last, to the one before');
      assert.strictEqual(a.close('nope'), null, 'a file not in the list closes nothing');
      assert.strictEqual(a.closedAll(), false, 'one left is not none');
      assert.strictEqual(a.close('1'), null, 'and the last of them leaves nothing to go to');
      assert.strictEqual(a.closedAll(), true, 'which is every file closed');
      assert.strictEqual(
        createOpenFiles({ tab: tabA, shared }).closedAll(),
        true,
        'and stays so on a reload, so a bare address does not hand the closed one back',
      );

      tabA.m.set(OPEN_KEY, '{not json');
      shared.m.set(OPEN_KEY, JSON.stringify([entry('5', 'e.md'), { id: 6 }, null]));
      assert.deepStrictEqual(
        createOpenFiles({ tab: tabA, shared }).list().map((t) => t.id),
        ['5'],
        'a list that will not parse is no list, and an entry that is not one is dropped',
      );
      const refusing = {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
      };
      const mem = createOpenFiles({ tab: refusing as unknown as Storage, shared: null });
      assert.ok(mem.note(entry('7', 'g.md')), 'storage that refuses is not a reason to fail');
      assert.strictEqual(mem.list().length, 1, 'the list lasts as long as the page');
      const blocked = {
        get sessionStorage() {
          throw Object.assign(new Error('blocked'), { name: 'SecurityError' });
        },
      };
      assert.strictEqual(storageOf(blocked, 'sessionStorage'), null, 'nor is storage blocked');

      const page = await openPage(hostW);
      assert.deepStrictEqual(
        page.backend.openFiles.list(),
        [],
        'the web backend has a list, off its window\'s storage, which a test window has none of',
      );
      assert.deepStrictEqual(unhandled, [], 'and none of it left a rejection nobody handled');
    });
  });

  // Wired up.
  const read = (f) => fs.readFileSync(rootUrl(f), 'utf8');
  const backendSrc = read('./src/hosts/web/backend.ts');

  await t.test('the web backend is picked by createBackend, built, and not staged into the app', async () => {
    for (const p of pages) p.backend.close();
    for (const h of hosts) h.close();
    process.off('unhandledRejection', onUnhandled);
    const pageBackend = read('./public/backend.ts');
    assert.ok(
      pageBackend.indexOf('__REDLINE_HOST') < pageBackend.indexOf('__REDLINE_WEB') &&
        /__REDLINE_WEB\)[\s\S]*?import\('\.\/vendor\/backend-web\.js'\)/.test(pageBackend),
      'createBackend picks the web backend, after the shell and before http',
    );
    const buildWeb = read('./scripts/build-web.mts');
    assert.match(buildWeb, /hosts\/web\/backend\.ts.*backend-web\.js/, 'backend-web.js is built');
    assert.match(buildWeb, /hosts\/web\/worker\.ts.*reader-worker\.js/,
      'reader-worker.js is built');
    assert.match(
      read('./scripts/stage-page.mts'),
      /web: \{\s*bundles: \['backend-web\.js', 'reader-worker\.js'\]/,
      'and they are the web host\'s, which is what keeps them out of the desktop app (12e)',
    );
    const workerSrc = read('./src/hosts/web/worker.ts');
    assert.match(
      workerSrc,
      /SharedWorkerGlobalScope[\s\S]*onconnect = \(e\) => host\.connect\(e\.ports\[0\]\)/,
      'a SharedWorker connects each port to the host, and only a SharedWorker does',
    );
    assert.match(
      backendSrc,
      /new globalThis\.SharedWorker\(WORKER_URL, \{ type: 'module', name: workerName\(\) \}\)/,
      'the page joins the one worker named for its build (12e)',
    );
    assert.ok(
      /inner\.bye\(\)/.test(backendSrc) &&
        /addEventListener\?\.\('pagehide', onPageHide\)/.test(backendSrc) &&
        /if \(!e\.persisted\) return;\s+port\.postMessage\(\{ t: 'hello'/.test(backendSrc) &&
        /addEventListener\?\.\('pageshow', onPageShow\)/.test(backendSrc),
      'the page says bye as it hides, and hello as it comes back from the cache',
    );
    assert.ok(
      /\.requestPermission\(/.test(backendSrc) && !/\.requestPermission\(/.test(workerSrc),
      'only the page asks the user for a permission: it needs a window and a click',
    );
    {
      const code = backendSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.deepStrictEqual(
        code.match(/\b(?:setInterval|setTimeout|Date\.now)\b/g),
        ['setInterval'],
        'the page has one timer in it, and no clock of its own',
      );
      assert.match(
        code,
        /setInterval\(\(\) => port\.postMessage\(\{ t: 'ping' \}\), pingMs\)/,
        'and it is the ping',
      );
    }
    for (const bundle of ['backend-web.js', 'reader-worker.js']) {
      const file = rootUrl(`public/vendor/${bundle}`);
      assert.ok(fs.existsSync(file), `build:web writes ${bundle}`);
      assert.ok(!/node:/.test(fs.readFileSync(file, 'utf8')),
        `${bundle} imports nothing from node`);
    }
    assert.ok(
      !read('./public/vendor/backend-web.js').includes('unreadable') &&
        read('./public/vendor/reader-worker.js').includes('unreadable'),
      'the page\'s half is not the reader, which is in the worker\'s',
    );
  });

  // The page's wiring to the welcome and to caps (test #12).
  // The tests above prove the welcome works; none of them runs app.js, which needs a DOM. So the
  // seams are read: a welcome that is correct and unreachable would pass every one of them.
  await t.test('the left column lists the files open in the web app, and is not in a CLI tab', async (t) => {
    await t.test('the page shows #welcome with no document or a lapsed grant, and hides git', async () => {
      const main = pageHtml.slice(pageHtml.indexOf('<main'), pageHtml.indexOf('</main>'));
      assert.match(
        main,
        /<section id="welcome" class="welcome" hidden><\/section>/,
        '#welcome is in the page, in main, and starts hidden',
      );
      assert.match(pageHtml, /<div id="notice" class="notice" role="status" hidden><\/div>/);
      // An author `display` beats `[hidden]` (CLAUDE.md, thing 3): each thing that is toggled with
      // the attribute needs its own rule, and the welcome's children share one.
      for (const [sel, rule] of [
        ['#welcome', /\.welcome\[hidden\],\s*\.welcome \[hidden\]\s*\{\s*display: none;/],
        ['#notice', /\.notice\[hidden\]\s*\{\s*display: none;/],
        ['the git option', /\.seg label\[hidden\]\s*\{\s*display: none;/],
        ['the document', /\.markdown-body\[hidden\]\s*\{\s*display: none;/],
      ] as const) {
        assert.match(pageCss, rule, `${sel} has a [hidden] rule of its own`);
      }

      assert.ok(
        /const welcome = backend\.welcome\?\.\(\{/.test(appJs) &&
          /open: \(path\) => doors\.open\(path\),\s*granted: \(\) => doors\.granted\(\),/.test(appJs) &&
          /bindWelcome\(\{ open: \(path\) => openFile\(path\), granted: \(\) => reopened\(\) \}\);/
            .test(appJs) &&
          /show: \(view\) => \(welcomeView\.value = view\),/.test(appJs),
        "the page gives the backend's welcome a way to open what it is handed, and to be drawn",
      );
      assert.match(
        appJs,
        /const pickFile = welcome \? mountWelcome\(welcomeEl, welcome, \(\) => backToDocument\(\)\) : null;/,
        'which ui/Welcome.tsx draws into the section, and only where there is one',
      );
      assert.match(read('./public/app/ui/Welcome.tsx'), /const v = welcomeView\.value;/,
        'from the view the backend last handed over');
      assert.ok(
        /!welcome \|\| !\['NoDocument', 'NeedsPermission'\]\.includes\(err\?\.name\)/.test(appJs) &&
          new RegExp(
            String.raw`if \(err\.name === 'NoDocument'\) \{[^}]*?closeDocument\(\);\s*\} ` +
              String.raw`else \{\s*showWelcome\(\{ reopen: welcomeAsks \?\? 'this file' \}\);`,
          ).test(appJs),
        'a document that is none, or must be asked for again, shows the welcome, and only with one',
      );
      assert.match(
        appJs,
        /backend\.onNeedsPermission\?\.\(\(\{ name \}\) => showWelcome\(\{ reopen: name \}\)\);/,
        'the backend naming a lapsed file shows it, with its name',
      );
      assert.match(appJs, /hideWelcome\(\);\s*(?:\/\/[^\n]*\s*)*paint\((?:\{ reuse: keepScroll \})?\);/,
        'and a document that paints hides it');
      const hooks = appJs.match(/backend\.welcome\?\.\(\{([\s\S]*?)\n\}\);/)?.[1] ?? '';
      assert.ok(
        /notify: \(text\) => notify\(text\),/.test(hooks) &&
          /showing: \(\) => !welcomeEl\.hidden,/.test(hooks),
        'a drop on a document is answered by the notice, and never puts the welcome up',
      );
      assert.match(
        appJs,
        /doc\.replaceChildren\(\);\s*clearSidebars\(\);/,
        'a document that is none takes Contents and History with it',
      );
      const clearing = appJs.match(/function clearSidebars\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
      assert.deepStrictEqual(
        clearing.trim().split('\n').map((l) => l.trim()),
        ['paintToc(null);', 'paintHistory(null);'],
        // Both lists are Preact's, and empty themselves on null; a replaceChildren under either
        // would leave Preact diffing against rows that are no longer there.
        'which resets what they keep and empties their lists',
      );
      assert.ok(
        /\n\.welcome-limits a \{\s*color: var\(--mod\);/.test(pageCss) &&
          !/\.?welcome-(list|folder|files?)\b/.test(
            pageCss + read('./src/hosts/web/welcome.ts') + read('./public/app/ui/Welcome.tsx'),
          ),
        'the way to the Mac app is drawn as a link, and the folder list the welcome had is gone',
      );
      {
        const files = read('./public/app/vm/files.ts');
        assert.ok(
          /^bindWelcome\(\{ open: \(path\) => openFile\(path\)/m.test(files) &&
            /^doc\.addEventListener\('click', /m.test(files) &&
            /import \{ scrollMemory, selectTab, closeTab \} from '\.\/vm\/files\.js';/.test(
              read('./public/app/main.ts'),
            ),
          'vm/files.ts opens the welcome\'s files and takes the links out, and main.ts mounts its rows',
        );
      }
      assert.match(
        appJs,
        /const why = await backend\.linkNote\?\.\(state\.data\?\.path\);\s*if \(why\) notify\(why\);/,
        'a link a file cannot follow says why, rather than doing nothing',
      );

      // The way from a document to another file, which only the web app has: Open file… at the
      // foot of the open files, and ⌘O. The bar has no button of its own for it.
      assert.ok(
        ![pageHtml, appJs, pageCss].some((src) => /openBtn/.test(src)),
        'there is no Open button by the name',
      );
      assert.match(
        appJs,
        /e\.key === 'Escape' && prefsOpen\.value === null\) backToDocument\(\);/,
        'Escape goes back to the document, and does not when it is closing Settings',
      );
      assert.match(
        appJs,
        /if \(welcome && e\.code === 'KeyO' && \(e\.metaKey \|\| e\.ctrlKey\)[^{]*\{\s*e\.preventDefault\(\);\s*if \(prefsOpen\.value === null\) pickFile\(\);/,
        '⌘O is the same, in the web app alone: a window has File ▸ Open…',
      );
      assert.ok(
        /welcome: \(hooks\) => mountWelcome\(\{ backend: api, win, \.\.\.hooks \}\)/.test(backendSrc) &&
          ['./src/hosts/tauri/backend.ts', './public/backend.ts', './src/rpc/client.ts'].every(
            (f) => !/welcome|linkNote/.test(read(f)),
          ),
        'only the web backend has a welcome, so the page never shows one in a shell or a server',
      );

      // P7: what the host cannot do is not offered.
      assert.match(
        settingsTsx,
        /\{ value: 'git', text: 'git HEAD', id: 'setBaselineGit', hidden: !git \}/,
        'the git baseline option is in the sheet, hidden but where there is git',
      );
      assert.strictEqual((pageHtml + appJs).match(/value: 'git'|value="git"/g).length, 1,
        'and nothing else offers git');
      assert.match(appJs, /state\.caps = data\.caps \?\? null;/,
        'every payload says what the reader can do');
      assert.match(settingsTsx, /const git = Boolean\(state\.caps\?\.git\);/,
        'the git option is shown on caps.git and on nothing else, and unknown is none',
      );
      assert.match(
        settingsTsx,
        /value=\{s\.baseline === 'git' && git \? 'git' : 'read'\}/,
        'and a saved choice of git is not shown as made where there is none',
      );

      // The shim: what makes this the web app, and what must not.
      assert.strictEqual(
        read('./src/hosts/web/host.js').replace(/\/\/.*$/gm, '').trim(),
        'globalThis.__REDLINE_WEB = true;',
        'the web shim says one thing',
      );
      assert.ok(
        !/__REDLINE_WEB/.test(read('./public/host.js')),
        'and the one the Mac app and the CLI load does not say it',
      );
      assert.ok(
        /^<!doctype html>/i.test(pageHtml) && /src="host\.js"/.test(pageHtml.slice(0, 600)),
        'host.js is the first script in the page, where the shim has to be',
      );
    });

    // The left column: the files open, the web app's as the desktop app's, and none at all in a
    // CLI tab, which is handed one file and keeps no list. Whether there is a column is known
    // before first paint, so the head script asks it as app.js does; a CLI tab that saved `side`
    // open in a desktop window's origin -- `npm run dev` is one -- would otherwise open on an
    // empty strip.
    await t.test('the left column lists the files open in the web app, and is not in a CLI tab', async () => {
      const webAt = pageHtml.indexOf('if (globalThis.__REDLINE_WEB) document.documentElement');
      assert.ok(
        webAt > 0 && webAt < pageHtml.indexOf('const sideOn ='),
        'the head script marks the web app before it decides on the left column',
      );
      assert.match(
        pageHtml,
        /const sideOn =\s+document\.documentElement\.matches\("\.native, \.web"\) &&/,
        'and opens it only where there is one',
      );
      assert.match(
        appJs,
        /const leftColumn = document\.documentElement\.matches\('\.native, \.web'\);/,
        'which app.js asks the same way',
      );
      assert.match(
        appJs,
        /if \(e\.altKey\) setTocSide\(!state\.tocSide\);\s+else if \(leftColumn\) setSide/,
        'so that ⌘B in a CLI tab does nothing',
      );
      assert.match(
        pageCss,
        /html:not\(\.native\):not\(\.web\) #side \{\s+display: none;/,
        'and its button is not there',
      );
      const leftAside = pageHtml.slice(
        pageHtml.indexOf('<aside id="files"'),
        pageHtml.indexOf('</aside>', pageHtml.indexOf('<aside id="files"')),
      );
      assert.match(
        leftAside,
        /<section id="filesSec" class="side-sec side-grow">/,
        'Open files is the left column wherever there is one, not only in the desktop app',
      );
      assert.ok(
        !/folderSec|paintFolder|backend\.folder|data-web/.test(pageHtml + appJs + pageCss) &&
          !/async folder\(\)/.test(backendSrc),
        'and the folder list it replaces is gone, all of it',
      );
      assert.match(
        appJs,
        /const openFiles = backend\.openFiles \?\? null;\nif \(openFiles\) state\.tabs = /,
        'the page takes the web backend\'s list as its tabs',
      );
      assert.ok(
        /openFiles: createOpenFiles\(\{\s+tab: storageOf\(win, 'sessionStorage'\),/.test(
          backendSrc,
        ) && /\s+shared: storageOf\(win, 'localStorage'\),\s+\}\),/.test(backendSrc),
        'which keeps it per tab, and the last one for a bare visit',
      );
      const selectFn = appJs.match(/function selectTab\([\s\S]*?\n\}/)?.[0] ?? '';
      const closeTabFn = appJs.match(/function closeTab\([\s\S]*?\n\}/)?.[0] ?? '';
      assert.ok(
        /if \(native\) native\.selectTab\(id\);\s+else switchTo\(id\);/.test(selectFn) &&
          /if \(native\) native\.closeTab\(id\);\s+else closeOpen\(id\);/.test(closeTabFn),
        'a row switches and closes through the shell in a window, and through the page in a tab',
      );
      assert.deepStrictEqual(
        [/native\.selectTab\(/g, /native\.closeTab\(/g].map((re) => appJs.match(re)?.length),
        [1, 1],
        'and nothing calls the shell for it but those two, the rows and the menu included',
      );
      const loadFn = appJs.match(/async function load\([\s\S]*?\n\}/)?.[0] ?? '';
      const noteFn = appJs.match(/function noteOpen\([\s\S]*?\n\}/)?.[0] ?? '';
      assert.ok(
        /paint\((?:\{ reuse: keepScroll \})?\);\s+noteOpen\(\);/.test(loadFn) &&
          /if \(err\.name === 'NoDocument'\) \{[\s\S]*?closeDocument\(\);/.test(loadFn),
        'every document shown is noted, whatever opened it, and one that is gone is put down',
      );
      assert.ok(
        /if \(!openFiles\) return;/.test(noteFn) &&
          /openFiles\.note\(\{\s+id: state\.docId,\s+path: d\.path,/.test(noteFn) &&
          /=== null && state\.tabs\.length > 1\) setSide\(true, false\);/.test(noteFn),
        'into the list, which opens the column at the second file as the desktop app does',
      );
      const switchFn = appJs.match(/async function switchTo\([\s\S]*?\n\}/)?.[0] ?? '';
      const closeFn = appJs.match(/async function closeOpen\([\s\S]*?\n\}/)?.[0] ?? '';
      assert.ok(
        /scrollMemory\.set\(state\.docId, pane\.scrollTop\)/.test(switchFn) &&
          /await openFile\(t\.path, \{ unopened: /.test(switchFn) &&
          /pane\.scrollTo\(0, scrollMemory\.get\(id\) \?\? 0\)/.test(switchFn),
        'a switch opens the file by its path, and keeps the place in each',
      );
      assert.match(appJs, /if \(unopened\) notify\(unopened\);/, 'and says so when it cannot');
      assert.ok(
        /const next = openFiles\.close\(id\);/.test(closeFn) &&
          /if \(id !== state\.docId\) return;/.test(closeFn) &&
          /if \(next && \(await switchTo\(next\.id\)\)\) return;/.test(closeFn) &&
          /\s+closeDocument\(\{ reopen: pendingLink \? welcomeAsks : null \}\);\n\}/.test(closeFn),
        'closing the one on screen goes to its neighbour, and closing the last to the welcome',
      );
      // What the bar draws from the document is drawn by `paint`, not by the sidebars, so a close
      // that empties the sidebars and not the bar leaves a count over the welcome for no file.
      const closeDocFn = appJs.match(/function closeDocument\([\s\S]*?\n\}/)?.[0] ?? '';
      assert.ok(
        // The version read alone is computed from `state.data`, so letting it go is what clears it.
        /state\.data = null;/.test(closeDocFn) &&
          /paintCount\(\);\s+paintRuler\(\);/.test(closeDocFn) &&
          /setLive\(true\);/.test(closeDocFn),
        'and the welcome has no count, arrows, ruler or dropped watch left on the bar from it',
      );
      assert.ok(
        /if \(!t\) return false;/.test(switchFn) &&
          /\.name\}\.` \}\)\)\) return false;/.test(switchFn) &&
          /\n  return true;\n\}$/.test(switchFn) &&
          /showWelcome\(\{ reopen \}\);/.test(appJs),
        'as does a neighbour that will not open, still asking for its folder if that is why',
      );
      assert.match(
        appJs,
        new RegExp(
          String.raw`if \(welcome\) \{[\s\S]{0,600}` +
            String.raw`\$\('newTab'\)\.addEventListener\('click', \(\) => pickFile\(\)\);`,
        ),
        'Open file… at the foot of the list is the file picker too',
      );
      assert.ok(
        /if \(!keepScroll \|\| welcomeAsks\) hideWelcome\(\);\s+(?:\/\/[^\n]*\s+)*paint\((?:\{ reuse: keepScroll \})?\);/.test(loadFn) &&
          (appJs.match(/hideWelcome\(\);/g) ?? []).length === 2,
        'a document opened takes the welcome down, and the one on screen read again does not',
      );
      assert.match(
        appJs,
        new RegExp(
          String.raw`\} else \{[^}]*?` +
            String.raw`if \(!state\.docId && openFiles\?\.closedAll\(\)\) \{` +
            String.raw`[^}]*?showWelcome\(\);\s+\} else if \(await load\(`,
        ),
        'drawn before the first load, and a tab that closed everything is not handed one back',
      );
    });
  });
});
