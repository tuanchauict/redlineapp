import { test } from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert';
import { createServer } from '../../src/hosts/node/server.js';
import { serveRpc } from '../../src/rpc/serve.js';
import { createSession } from '../../src/reader/session.js';
import { createRpcBackend } from '../../src/rpc/client.js';
import { rootUrl } from '../../src/hosts/node/root.js';
import type { Chunk, Reply } from '../support.js';
import { clientFor, pageJs, portOf, scratch, until } from '../support.js';

const tmp = scratch();

// Switching documents at runtime (the app's File > Open).
let fifth, base5, reader5;
const docA = path.join(tmp, 'a.md');

test('switch documents at runtime', async () => {
  const docB = path.join(tmp, 'b.md');
  fs.writeFileSync(docA, '# Alpha\n\nFirst document.\n');
  fs.writeFileSync(docB, '# Beta\n\nSecond document.\n');

  fifth = await createServer({ file: docA });
  await new Promise<void>((r) => fifth.server.listen(0, '127.0.0.1', r));
  base5 = `http://127.0.0.1:${portOf(fifth.server)}`;

  const events5 = [];
  const es5 = await fetch(base5 + '/events');
  reader5 = es5.body.getReader();
  (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader5.read().catch(() => ({ done: true }) as Chunk);
      if (done) break;
      for (const line of dec.decode(value).split('\n')) {
        if (line.startsWith('data: ')) events5.push(JSON.parse(line.slice(6)));
      }
    }
  })();

  assert.strictEqual(fifth.abs, docA);
  await assert.rejects(
    () => fifth.setFile(path.join(tmp, 'does-not-exist.md')),
    /cannot read/,
    'bad path throws',
  );
  assert.strictEqual(fifth.abs, docA, 'a failed open leaves the current document in place');

  await fifth.setFile(docB);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(
    events5.some((e) => e.type === 'file' && e.path === docB),
    `switch announced over SSE: ${JSON.stringify(events5)}`,
  );
  const docB1 = await clientFor(base5)('/api/doc');
  assert.strictEqual(docB1.name, 'b.md', 'server now serves the new document');
  assert.match(docB1.html, /Second document/);

  // the old file's watcher must be gone, the new one must be live
  events5.length = 0;
  fs.writeFileSync(docA, '# Alpha\n\nFirst document, edited.\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(events5.length, 0, 'edits to the closed document are ignored');
  fs.appendFileSync(docB, '\nAppended to beta.\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(events5.some((e) => e.type === 'change'), 'the new document is watched');
});

// Following a link to another file.
// The browser's version of what the app answers with a new window. The page
// resolves `./a.md` against the directory the document it is reading came out
// of — it has nothing else to resolve against, being served from a loopback
// port — and posts the absolute path here.
test('follow a link to a file beside this one', async () => {
  const opened = (await (
    await fetch(`${base5}/api/open?path=${encodeURIComponent(docA)}`, { method: 'POST' })
  ).json()) as Reply;
  assert.strictEqual(opened.path, docA, 'the referenced file is what got opened');
  assert.ok(opened.id, 'and the page is told the id it is now on');
  // The id comes back because it is not the one that was sent: the old document
  // is released by the switch, and a page still holding its id would be asking
  // after something that has closed.
  const followed = await clientFor(base5)(`/api/doc?id=${opened.id}`);
  assert.strictEqual(followed.name, 'a.md', 'and that id serves the new document');
  assert.match(followed.html, /First document, edited/);

  // A link a document has outlived. Nothing is released until the new file has
  // been read, so the page stays exactly where it was.
  const missing = await fetch(
    `${base5}/api/open?path=${encodeURIComponent(path.join(tmp, 'gone.md'))}`,
    { method: 'POST' },
  );
  assert.strictEqual(missing.status, 500, 'a link to a file that is not there fails');
  assert.strictEqual(fifth.abs, docA, 'and leaves the document that is open alone');

  // The page's half. Percent-escapes are markdown-it's doing, not the author's:
  // `[図](./図.md)` reaches the client as `./%E5%9B%B3.md`, and a path built from
  // that spelling exists on no disk — so the link is decoded before it is walked.
  assert.match(pageJs, /function linkTarget/, 'a link resolves to a file');
  assert.match(
    pageJs,
    /const bare = readable\(href\.split\('#'\)\[0\]/,
    'and is decoded before it is walked',
  );
  assert.match(pageJs, /walkPath\(dir, bare\)/, 'against the directory the document is in');
  assert.match(pageJs, /backend\.open\(path\)/, 'and a browser tab follows it in place');
  assert.match(pageJs, /async function openFile/, 'with the watch stood down across the swap');
  await reader5.cancel().catch(() => {});
  fifth.server.close();
});

// Several documents open at once (multiple windows / tabs).
let sixth, listen, lC, lD;
test('several documents open at once', async () => {
  const docC = path.join(tmp, 'c.md');
  const docD = path.join(tmp, 'd.md');
  fs.writeFileSync(docC, '# Gamma\n\nThird document.\n');
  fs.writeFileSync(docD, '# Delta\n\nFourth document.\n');

  sixth = await createServer({ file: docC });
  await new Promise<void>((r) => sixth.server.listen(0, '127.0.0.1', r));
  const base6 = `http://127.0.0.1:${portOf(sixth.server)}`;

  const idC = sixth.initialId;
  const idD = await sixth.retain(docD);
  assert.notStrictEqual(idC, idD, 'distinct files get distinct ids');
  assert.strictEqual(await sixth.retain(docD), idD, 'a second window on one file shares its id');
  // And two windows asking at the same moment still share it: opening a document
  // takes several awaits now, so the second must wait for the first rather than
  // build a rival document and evict it.
  assert.deepStrictEqual(
    await Promise.all([sixth.retain(docD), sixth.retain(docD)]),
    [idD, idD],
    'and so does a simultaneous pair',
  );
  sixth.release(idD);
  sixth.release(idD);
  sixth.release(idD);
                      // balance the extra retain

  const [dC, dD] = await Promise.all([
    fetch(`${base6}/api/doc?id=${idC}`).then((r) => r.json() as Promise<Reply>),
    fetch(`${base6}/api/doc?id=${idD}`).then((r) => r.json() as Promise<Reply>),
  ]);
  assert.strictEqual(dC.name, 'c.md', 'id selects the document');
  assert.strictEqual(dD.name, 'd.md', 'the second document is served alongside the first');
  assert.strictEqual(dD.id, idD, 'the payload carries its own id');

  // each listener hears only about its own file
  listen = async (id) => {
    const got = [];
    const res = await fetch(`${base6}/events?id=${id}`);
    const rd = res.body.getReader();
    (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await rd.read().catch(() => ({ done: true }) as Chunk);
        if (done) break;
        for (const line of dec.decode(value).split('\n')) {
          if (line.startsWith('data: ')) got.push(JSON.parse(line.slice(6)));
        }
      }
    })();
    return { got, rd };
  };
  lC = await listen(idC);
  lD = await listen(idD);

  fs.appendFileSync(docD, '\nMore delta.\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(lD.got.some((e) => e.type === 'change'), 'the edited document notifies its window');
  assert.strictEqual(lC.got.length, 0, 'the other window hears nothing');

  // closing one window leaves the other watching
  sixth.release(idD);
  assert.strictEqual(sixth.pathOf(idD), null, 'the closed document is gone');
  assert.strictEqual(sixth.pathOf(idC), docC, 'the open one stays');
  fs.appendFileSync(docC, '\nMore gamma.\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(lC.got.some((e) => e.type === 'change'), 'the surviving document is still watched');

  // a window that outlived its document says so, rather than showing the wrong file
  const gone = await fetch(`${base6}/api/doc?id=${idD}`);
  assert.strictEqual(gone.status, 410, 'a closed document is reported closed');
  const unnamed = (await (await fetch(`${base6}/api/doc`)).json()) as Reply;
  assert.strictEqual(unnamed.name, 'c.md', 'a request with no id still gets the open document');
});

test('a page behind a channel is answered as one behind http is', async () => {
  await Promise.all([lC.rd.cancel().catch(() => {}), lD.rd.cancel().catch(() => {})]);
  sixth.server.close();

  // The page behind a MessageChannel is answered as the page behind http is.
  // One reader, asked two ways. The session decided what every call means, so the transports may
  // differ in how a call arrives and in nothing else -- and this is the test that says so, rather
  // than each transport's own tests each hoping.
  {
    const docP = path.join(tmp, 'parity.md');
    fs.writeFileSync(docP, '# Parity\n\nOne.\n');
    const parity = await createServer({ file: docP });
    await new Promise<void>((r) => parity.server.listen(0, '127.0.0.1', r));
    const baseP = `http://127.0.0.1:${portOf(parity.server)}`;

    // node's MessagePort has the `onmessage` setter the web's does, and leaves it out of its types.
    type Receiving = { onmessage: (e: { data: any }) => void };
    const chan = new MessageChannel() as InstanceType<typeof MessageChannel> & {
      port1: Receiving;
      port2: Receiving;
    };
    const closeRpc = serveRpc({
      session: createSession(parity),
      post: (m) => chan.port1.postMessage(m),
      onMessage: (h) => {
        chan.port1.onmessage = (e) => h(e.data);
      },
    });
    const rpc = createRpcBackend({
      docId: () => parity.initialId,
      post: (m) => chan.port2.postMessage(m),
      onMessage: (h) => {
        chan.port2.onmessage = (e) => h(e.data);
      },
      host: { kind: 'test' },
    });
    // What an http client receives has been through JSON; what a channel delivers has been through
    // structured clone, which keeps an `undefined`. Neither is the reader's concern.
    const plain = (v) => JSON.parse(JSON.stringify(v));
    const httpP = async (p, init?) => {
      const res = await fetch(`${baseP}${p}${p.includes('?') ? '&' : '?'}id=${parity.initialId}`, init);
      return { status: res.status, body: (await res.json()) as Reply };
    };

    assert.deepStrictEqual(
      plain(await rpc.doc()),
      (await httpP('/api/doc')).body,
      'the document is the same payload either way',
    );
    assert.deepStrictEqual(
      await rpc.fonts(),
      (await httpP('/api/fonts')).body.fonts,
      'and so are the fonts',
    );

    // A change reaches a page that is listening over the channel, as it reaches one on /events.
    const heard = [];
    const lives = [];
    const unwatch = rpc.watch({
      onEvent: (e) => heard.push(e),
      onLive: (on, why) => lives.push([on, why]),
    });
    await until(() => lives.length, 'the watch to go live');
    assert.deepStrictEqual(lives[0], [true, undefined], 'the watch is live once the reader has it');
    fs.appendFileSync(docP, '\nTwo.\n');
    await until(() => heard.some((e) => e.type === 'change'), 'a change over the channel');
    const changed = (await httpP('/api/doc')).body;
    assert.deepStrictEqual(plain(await rpc.doc()), changed, 'the changed document is the same too');
    assert.ok(changed.text.includes('Two.'), 'with the edit in it');

    // The same call, made both ways, leaves the same answer.
    assert.deepStrictEqual(
      plain(await rpc.markRead()),
      (await httpP('/api/mark-read', { method: 'POST' })).body,
      'marking read answers with the same document',
    );
    const keyP = 'parity-key';
    assert.deepStrictEqual(await rpc.ack({ key: keyP }), [keyP], 'a check-off over the channel');
    assert.deepStrictEqual(
      (await httpP(`/api/ack?key=${keyP}`, { method: 'POST' })).body.acked,
      [keyP],
      'and over http, which already knows it',
    );
    assert.deepStrictEqual(await rpc.ack({ clear: true }), [], 'clearing');

    // A call that is wrong in itself is the same refusal: a 400 on one, a BadRequest on the other.
    const noKey = await httpP('/api/ack', { method: 'POST' });
    assert.strictEqual(noKey.status, 400, 'http refuses a nameless check-off');
    await assert.rejects(rpc.ack({}), { name: 'BadRequest', message: noKey.body.error });
    await assert.rejects(rpc.open(''), { name: 'BadRequest' }, 'and a link to no file');

    // Versions: two more edits make something to clean up, and what is left is the same either way.
    for (const n of ['Three.', 'Four.']) {
      const seen = (await httpP('/api/doc')).body.history.length;
      fs.appendFileSync(docP, `\n${n}\n`);
      await until(async () => (await httpP('/api/doc')).body.history.length > seen, `version ${n}`);
    }
    const versions = (await httpP('/api/doc')).body.history;
    const cut = versions.at(-2);
    const trimmed = await rpc.prune(cut.hash);
    assert.ok(trimmed.removed >= 1, 'the clean-up over the channel forgot something');
    const head2 = trimmed.history.find((h) => h.current);
    assert.deepStrictEqual(
      plain(await rpc.prune(head2.hash)),
      (await httpP(`/api/prune?upto=${head2.hash}`, { method: 'POST' })).body,
      'refusing to forget the newest is the same answer on both',
    );
    // Reading up to an older version, the same both ways; and a version is a string or nothing.
    const olderP = trimmed.history.find((h) => !h.current);
    assert.deepStrictEqual(
      plain(await rpc.markRead(olderP.hash)),
      (await httpP(`/api/mark-read?at=${olderP.hash}`, { method: 'POST' })).body,
      'marking an older version read answers with the same document',
    );
    // 42 is not a version, on purpose.
    await assert.rejects(
      rpc.markRead(42 as unknown as string),
      { name: 'BadRequest' },
      'and a version that is not one is refused',
    );
    // Every backend the page can be handed takes the version along.
    for (const [f, through] of [
      ['./src/rpc/client.ts', /markRead: \(at\) => call(?:<\w+>)?\('markRead', docId\(\), at\),/],
      ['./src/hosts/tauri/backend.ts', /markRead: \(at\) => reader\.markRead\(docId\(\), at\),/],
      ['./public/backend.ts', /markRead: \(at\) => post\('\/api\/mark-read', \{ at \}\),/],
      ['./src/hosts/web/worker.ts', /markRead: async \(id, at\) => session\.markRead\(await owned\(conn, id\), at\),/],
    ] as const) {
      assert.match(fs.readFileSync(rootUrl(f), 'utf8'), through, `${f} passes the version on`);
    }

    // Following a link: both land on the sibling, and the page is told the id it is on now.
    const sibling = path.join(tmp, 'parity-sibling.md');
    fs.writeFileSync(sibling, '# Sibling\n');
    unwatch();
    const opened = await rpc.open(sibling);
    assert.strictEqual(opened.path, sibling, 'a link followed over the channel');
    assert.notStrictEqual(opened.id, parity.initialId, 'lands on a document of its own');
    const gonePage = await httpP('/api/doc');
    assert.strictEqual(gonePage.status, 410, 'and the id it left is closed, as http says');
    await assert.rejects(rpc.doc(), { name: 'Closed' }, 'which the channel says in its own words');
    await assert.rejects(
      new Promise((_, no) =>
        rpc.watch({ onEvent() {}, onLive: (on, why) => on || no(new Error(why)) }),
      ),
      /no longer open/,
      'and a watch on it is not live',
    );

    // What a page can call is what the other backends offer -- the page is written to one surface.
    const { createBackend } = await import(rootUrl('public/backend.js').href);
    const httpKeys = Object.keys(await createBackend({ docId: () => null }));
    assert.deepStrictEqual(
      Object.keys(rpc).filter((k) => httpKeys.includes(k)).sort(),
      httpKeys.sort(),
      'the channel backend has every method the http one does',
    );

    // And the layer between is wired: the server answers through the session, not around it.
    assert.match(
      fs.readFileSync(rootUrl('src/hosts/node/server.ts'), 'utf8'),
      /createSession\(reader\)/,
      'the http routes are the session',
    );
    closeRpc();
    chan.port1.close();
    chan.port2.close();
    parity.server.close();
  }
});
