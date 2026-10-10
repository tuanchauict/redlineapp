// The web app's reader, out of the page: one per origin in a SharedWorker, so that every tab
// shares one watcher and one writer to the store, and in the page itself where there is no
// SharedWorker. `createWebHost()` is all of it; the last lines only point a SharedWorker's
// `onconnect` at one.
//
// A page is one port, and a port is one `serveRpc` over a session of its own. That session is
// the reader's, with three things put between: a page is shown only the document it holds (the
// reader answers "whichever is open" to an id it is not given, and in a worker that is some other
// tab's file), a document is held from `hello` to `bye` and not for ever, and a document whose
// folder has to be asked for again says so instead of failing.
//
//   hello   retain the document the page says it shows -- by what `opened` remembers, which for a
//           reload is the whole of how the file is found, after asking `queryPermission`
//   bye     release it. A page in the back/forward cache is gone as far as this is concerned,
//           and says hello again when it comes back
//   ping    nothing, but any message counts as "still there": a connection silent for
//           `silentMs` is released, and revived by the next thing it says. A tab that is
//           killed sends no bye, and nothing here can see a port close
//
// `requestPermission` is not here. It needs a window and a click, so the page calls it and then
// tells this side with `grant`.
import { createReader, Closed } from '../../reader/reader.js';
import { BadRequest, createSession } from '../../reader/session.js';
import { serveRpc } from '../../rpc/serve.js';
import { createHandles, NeedsPermission, NoDocument, parseWebPath, webPath } from './handles.js';
import { createIdbKv } from './idb.js';
import { createWebPlatform } from './platform.js';

/** How long a connection may say nothing before the document it holds is let go. */
export const SILENT_MS = 30_000;
/** How often to look for one. The page pings three times in a silence this long. */
const SWEEP_MS = 5_000;

const isHandle = (h) =>
  (h?.kind === 'directory' || h?.kind === 'file') &&
  typeof h.name === 'string' &&
  typeof h.queryPermission === 'function';

// A dropped file is `drop:<name>`, and a name is all a path has to go on. Nothing a `File` can
// be called is a separator, but the path is made here, so it is checked here.
const safeName = (n) => typeof n === 'string' && n !== '.' && n !== '..' && /^[^/\\]+$/.test(n);

/**
 * @param {object} [opts]
 * @param {{ files: object, roots: object, opened: object }} [opts.stores]
 *   The three IndexedDB stores, as `idb.js` makes them. Default: those.
 * @param {number} [opts.pollMs]  Passed to the reader.
 * @param {number} [opts.silentMs]
 * @param {number} [opts.sweepMs]
 * @param {() => number} [opts.now]
 */
export function createWebHost({
  stores,
  pollMs,
  silentMs = SILENT_MS,
  sweepMs = SWEEP_MS,
  now = Date.now,
} = {}) {
  const kv = stores ?? {
    files: createIdbKv('files'),
    roots: createIdbKv('roots'),
    opened: createIdbKv('opened'),
  };
  const handles = createHandles({ roots: kv.roots, opened: kv.opened });
  const drops = new Map();
  const platform = createWebPlatform({ kv: kv.files, root: handles.root, drops });

  // The reader is async to build and a page can speak before it is built, so calls wait for it
  // (`readerP`) and code that has already waited reads it from here.
  let reader = null;
  let session = null;
  const readerP = createReader({ platform, label: handles.label, pollMs }).then((r) => {
    session = createSession((reader = r));
    return r;
  });
  // A failure is every call's to report, in its own `err`; this only keeps it from also being
  // an unhandled rejection of its own.
  readerP.catch(() => {});

  const conns = new Set();

  // --- what a connection holds ---------------------------------------------

  /** Let go of the document a connection holds, and call off an acquire still on its way. */
  function release(conn) {
    conn.gen++;
    const held = conn.held;
    conn.held = null;
    if (held) reader.release(held);
  }

  /**
   * Take hold of the document `conn.docId` names, if it can be found and may be read. Never
   * throws: what went wrong is left on the connection, for the next call to say.
   *
   * `gen` is how a slow one notices it has been overtaken -- by a bye, a newer hello, an open --
   * and gives back what it took rather than keep a document nobody is holding it for.
   */
  function acquire(conn) {
    const gen = ++conn.gen;
    conn.pending = null;
    conn.failure = null;
    conn.busy++;
    return (async () => {
      let rootId = null;
      try {
        await readerP;
        const id = conn.docId;
        if (!id) return;
        // Open already, for another tab or an earlier visit of this one: join it. Otherwise the
        // id is only a hash, and `opened` is what says which file it was a hash of.
        let path = reader.pathOf(id);
        if (path) {
          rootId = parseWebPath(path)?.rootId ?? null;
        } else {
          const was = await handles.openedAs(id);
          if (!was) return;
          rootId = was.rootId;
          const state = await handles.permission(rootId);
          if (gen !== conn.gen) return;
          if (state === 'prompt') {
            conn.pending = { rootId };
            return;
          }
          // Denied, or the handle is gone: nothing here to open, and `doc` says so.
          if (state !== 'granted') return;
          path = webPath(rootId, was.rel);
        }
        const held = await reader.retain(path);
        if (gen !== conn.gen) {
          reader.release(held);
          return;
        }
        conn.held = held;
      } catch (err) {
        if (gen !== conn.gen) return;
        // `queryPermission` said yes and the read said no: the grant went between the two.
        if (err?.name === 'NotAllowedError' && rootId) conn.pending = { rootId };
        else conn.failure = err;
      } finally {
        conn.busy--;
      }
    })();
  }

  const settled = (conn) => reader != null && conn.busy === 0;

  /**
   * The id of the document this connection holds, or the reason it holds none. A page that
   * names a different one is stale, and is told so, as a window on a closed document is.
   * Never `reader.idOf`: with no id it would answer with whichever document is first open, and
   * in a worker that is somebody else's.
   */
  function mine(conn, id) {
    if (conn.held) {
      if (!id || id === conn.held) return conn.held;
      throw new Closed();
    }
    if (conn.pending) {
      throw new NeedsPermission(handles.nameOf(conn.pending.rootId) ?? 'this folder');
    }
    if (conn.failure) throw conn.failure;
    throw new NoDocument();
  }

  /** `mine`, once the hello has been dealt with. */
  async function owned(conn, id) {
    await readerP;
    await conn.ready;
    return mine(conn, id);
  }

  // --- a connection's session ----------------------------------------------

  function sessionFor(conn, post) {
    const live = (on, why, needs) => post({ t: 'live', on, why, needs });

    return {
      async doc(id, baseline) {
        await readerP;
        // A document still waiting to be allowed is asked about again on every call, so that
        // allowing it in the browser's own settings works as well as the Reopen button.
        if (!conn.held && conn.pending) conn.ready = acquire(conn);
        const held = await owned(conn, id);
        const was = parseWebPath(reader.pathOf(held));
        // The permission is asked about here as well as by the poll, because the poll says so
        // once and a page that was not listening then -- in the back/forward cache, say -- would
        // otherwise be shown the old text and told nothing.
        if (was) {
          const state = await handles.permission(was.rootId);
          if (state === 'prompt') throw new NeedsPermission(handles.nameOf(was.rootId));
          if (state !== 'granted') throw new NoDocument();
        }
        try {
          return await session.doc(held, baseline);
        } catch (err) {
          // `queryPermission` and the read can disagree for a moment; the read is right.
          if (was && err?.name === 'NotAllowedError') {
            throw new NeedsPermission(handles.nameOf(was.rootId));
          }
          throw err;
        }
      },

      markRead: async (id) => session.markRead(await owned(conn, id)),
      ack: async (id, opts) => session.ack(await owned(conn, id), opts),
      prune: async (id, upto, baseline) => session.prune(await owned(conn, id), upto, baseline),
      plantumlSvg: async (code) => (await readerP, session.plantumlSvg(code)),
      fonts: async () => (await readerP, session.fonts()),

      /**
       * Show a different file in this page. Not `session.open`, which is `reader.setFile`: that
       * moves every listener on the old document to the new one, which is right for a browser
       * tab that follows whatever the server opened and wrong for a tab that shares a worker
       * with others, where one tab's link would take every tab on that file along with it.
       */
      async open(_id, path) {
        if (!path) throw new BadRequest('no file named');
        await readerP;
        // Only what a page was given: a file under a folder it granted, or one it dropped. The
        // store is under the same platform, and is not a document.
        if (!/^(web:|drop:)/.test(platform.resolve(path))) {
          throw new BadRequest('Redline reads only files it was given');
        }
        await conn.ready;
        const next = await reader.retain(path); // throws before anything is released
        const abs = reader.pathOf(next);
        const was = parseWebPath(abs);
        try {
          if (was) await handles.rememberOpened(next, was.rootId, was.rel);
        } catch (err) {
          reader.release(next);
          throw err;
        }
        const prev = conn.held;
        conn.gen++; // an acquire still on its way must not put the page back
        conn.docId = next;
        conn.held = next;
        conn.pending = null;
        conn.failure = null;
        if (prev) reader.release(prev);
        return { id: next, path: abs };
      },

      /**
       * Follow the held document. Synchronous, as `serveRpc` wants, so a hello that is still
       * being dealt with is waited for in the background, and a failure then is said as a watch
       * that is not live -- after the `ret` that says it was subscribed, not before it.
       */
      watch(id, onEvent) {
        let off = null;
        let stopped = false;
        const subscribe = () =>
          session.watch(mine(conn, id), (e) => {
            if (e.type === 'readable') return live(true);
            if (e.type !== 'unreadable') return onEvent(e);
            // The poll said it cannot read the file. A grant that was taken back is the one
            // kind the page can do something about.
            if (e.name === 'NotAllowedError') {
              return live(false, 'Permission to read this file was taken back', 'permission');
            }
            live(false, e.why || 'The file cannot be read');
          });
        // `live` is told after the `ret` that says the watch is subscribed, never before it: the
        // page reads that `ret` as "live", and would undo a "not live" that came first.
        const notLive = (err) => {
          if (stopped) return;
          if (err?.name === 'NeedsPermission') return live(false, err.message, 'permission');
          live(false, err?.name === 'Closed' ? 'That document is no longer open' : err.message);
        };

        if (settled(conn)) {
          try {
            off = subscribe();
          } catch (err) {
            // Waiting for a click is a state of the watch. Anything else is a refusal of it.
            if (err?.name !== 'NeedsPermission') throw err;
            setTimeout(() => notLive(err), 0);
          }
        } else {
          // A hello is still being dealt with, and `watch` cannot wait for it, so it is
          // subscribed once it is done, and a failure then is a watch that is not live.
          Promise.all([readerP, conn.ready]).then(() =>
            setTimeout(() => {
              if (stopped) return;
              try {
                off = subscribe();
              } catch (err) {
                notLive(err);
              }
            }, 0),
          );
        }
        return () => {
          stopped = true;
          off?.();
        };
      },
    };
  }

  // --- what only this host can be asked ------------------------------------

  const extra = {
    /** Keep a folder or file handle the page was given. Answers `{ rootId, name, kind }`. */
    async addRoot(handle) {
      if (!isHandle(handle)) throw new BadRequest('not a folder or file handle');
      return handles.addRoot(handle);
    },

    /**
     * Take a file that came with no handle: a drop on a browser that cannot hand one over, or an
     * `<input type=file>`. Answers its path, which `open` takes from here. The same name dropped
     * again replaces it, so the next poll reads the new file and the history gains a version.
     */
    addDrop(file) {
      if (typeof file?.text !== 'function' || !safeName(file.name)) {
        throw new BadRequest('not a file');
      }
      drops.set(file.name, file);
      return `drop:${file.name}`;
    },

    /**
     * The page asked the user for a root again and was told yes. Documents that were waiting on
     * it are taken now; ones already held are not touched, because the reader's poll is still
     * running and finds the file readable on its own.
     */
    async grant(rootId) {
      if ((await handles.permission(rootId)) !== 'granted') return false;
      await readerP;
      for (const c of conns) if (c.pending?.rootId === rootId) c.ready = acquire(c);
      await Promise.all([...conns].map((c) => c.ready));
      return true;
    },
  };

  // --- connections ----------------------------------------------------------

  /**
   * Serve one page over `port`: a MessagePort, or anything shaped like one (`postMessage`,
   * settable `onmessage`). Returns the function that stops serving it.
   */
  function connect(port) {
    const conn = {
      docId: null, // what the page said it shows
      held: null, // the reader's id for it, once taken
      pending: null, // { rootId }: taken, once the user says so
      failure: null,
      gen: 0,
      busy: 0,
      ready: Promise.resolve(),
      seen: now(),
      swept: false,
    };
    conns.add(conn);
    const post = (msg) => port.postMessage(msg);

    const stop = serveRpc({
      session: sessionFor(conn, post),
      post,
      extra,
      onMessage: (handler) => {
        port.onmessage = (e) => {
          const msg = e.data;
          conn.seen = now();
          // Something said after being let go of: the page is alive, only slow to be heard
          // from -- a background tab's timers can be held back for minutes. A bye or a hello
          // is the page deciding, and decides for itself.
          if (conn.swept && msg?.t !== 'hello' && msg?.t !== 'bye') {
            conn.swept = false;
            // Nothing was watching the file while it was let go of, so what the page shows may be
            // out of date; a `change` makes it look again, as it would for an edit.
            conn.ready = acquire(conn).then(() => {
              if (conn.held) post({ t: 'ev', e: { type: 'change' } });
            });
          }
          if (msg?.t === 'ping') return; // not the protocol's: `serveRpc` would only ignore it
          handler(msg);
        };
        return () => {
          port.onmessage = null;
        };
      },
      onHello(doc) {
        release(conn); // a page that says hello over a document it holds is starting again
        conn.docId = doc;
        conn.swept = false;
        conn.ready = acquire(conn);
      },
      onBye() {
        release(conn);
        conn.swept = false;
      },
    });

    return () => {
      stop();
      release(conn);
      conns.delete(conn);
      port.close?.();
    };
  }

  // A tab that is closed says nothing and its port tells nobody, so a document is held for as
  // long as somebody has spoken lately. The ports themselves are kept: a silent one may be a
  // page that is only asleep.
  const sweeper = setInterval(() => {
    const t = now();
    for (const c of conns) {
      if (c.held && t - c.seen > silentMs) {
        release(c);
        c.swept = true;
      }
    }
  }, sweepMs);
  sweeper.unref?.();

  return {
    connect,

    /** The reader, once built. For a host that wants to look at what is open, and for tests. */
    reader: readerP,

    /** Let go of everything, and stop. */
    close() {
      clearInterval(sweeper);
      for (const c of [...conns]) release(c);
      conns.clear();
      reader?.closeAll();
    },
  };
}

// As a SharedWorker's script this is the whole of it. Imported by a page -- the fallback, and
// the tests -- there is no such scope and nothing happens.
if (
  typeof SharedWorkerGlobalScope !== 'undefined' &&
  globalThis instanceof SharedWorkerGlobalScope
) {
  const host = createWebHost();
  globalThis.onconnect = (e) => host.connect(e.ports[0]);
}
