// The page's end of the web app: find the reader, talk to it, and say what the user has to do
// when it cannot go on without them.
//
// The reader is in a SharedWorker (worker.js), one for every tab of this origin; where there is
// none, it is the same code in this page, behind a MessageChannel. Either way `createRpcBackend`
// does what it does for every host that is not in the page's own heap, and this wraps it with
// the three things a browser tab has that the others do not:
//
//   - the page's lifecycle. A tab that goes into the back/forward cache is not closed and not
//     alive, and the worker has to be told, so that it neither holds the document for ever nor
//     forgets the tab when it comes back
//   - permission. A folder the user granted last week may have to be granted again, and only a
//     page, from a click, can ask (`reopen`)
//   - the ways to open something that are not a link: a folder, a file, a drop
//
// Bundled to public/vendor/backend-web.js, and loaded only when `host.js` has said this is the
// web app, so no other build downloads it.
import { createRpcBackend } from '../../rpc/client.js';
import { createIdbKv } from './idb.js';

/** How often to tell the worker this page is still here. It lets go of a document after 30 s. */
export const PING_MS = 10_000;

// Resolved against this file, which is `vendor/backend-web.js` once bundled, so the worker is the
// bundle beside it. Not an import: the page must not download the reader unless it has to.
const WORKER_URL = new URL('./reader-worker.js', import.meta.url);

/**
 * Join the worker, or be one.
 *
 * @returns {Promise<{ port: MessagePort, onError: (fn: (why: string) => void) => void }>}
 */
export async function openPort() {
  if (typeof globalThis.SharedWorker === 'function') {
    const worker = new globalThis.SharedWorker(WORKER_URL, { type: 'module', name: 'redline' });
    return {
      port: worker.port,
      // Fired when the script cannot load or parse. A port that has never connected says nothing
      // else, and a page waiting on it would wait for ever.
      onError: (fn) => {
        worker.onerror = () => fn('Redline could not start its reader');
      },
    };
  }
  // The worker's module is a bundle of its own, and it is loaded here by the URL in a variable
  // so that nothing bundles it into this one: a browser that has a SharedWorker never needs it.
  // Each tab then has its own reader over the one IndexedDB store (008).
  const { createWebHost } = await import(WORKER_URL.href);
  const { port1, port2 } = new MessageChannel();
  createWebHost().connect(port2);
  return { port: port1, onError: () => {} };
}

/**
 * @param {object} opts
 * @param {() => string|null} opts.docId  The document being shown, read per call.
 * @param {typeof openPort} [opts.connect]  How to reach the reader. Default: `openPort`.
 * @param {{ roots: object, opened: object }} [opts.stores]  The IndexedDB stores, read here
 *   to hold the handle a permission prompt needs. Default: the real ones.
 * @param {EventTarget} [opts.win]  What fires `pagehide` and `pageshow`. Default: `window`.
 * @param {number} [opts.pingMs]
 */
export async function createWebBackend({
  docId,
  connect = openPort,
  stores,
  win = globalThis,
  pingMs = PING_MS,
}) {
  const kv = stores ?? { roots: createIdbKv('roots'), opened: createIdbKv('opened') };
  const { port, onError } = await connect();

  let disconnect = () => {};
  // `call` is kept to this file: the page is written against the surface and not the transport.
  const { call, ...inner } = createRpcBackend({
    docId,
    post: (msg) => port.postMessage(msg),
    onMessage: (handler) => {
      port.onmessage = (e) => handler(e.data);
    },
    onDisconnect: (fn) => {
      disconnect = fn;
    },
    host: { kind: 'web', links: 'in-place', external: 'browser', keys: 'page', url: true },
  });
  onError((why) => disconnect(why));

  // The worker lets go of a page that goes quiet, because a closed tab cannot say so.
  const pinger = setInterval(() => port.postMessage({ t: 'ping' }), pingMs);
  pinger.unref?.();

  // --- permission ----------------------------------------------------------

  const askers = new Set();
  // What the page would have to ask for, held from the moment it is known to be needed until the
  // click that asks: `requestPermission` wants a user gesture, and a gesture is not for waiting
  // on a database read.
  let pending = null;

  /** A root, with the handle to ask about it. Or null. */
  async function rootById(rootId) {
    const rec = rootId ? await kv.roots.get(rootId) : null;
    return rec ? { rootId, name: rec.name, handle: rec.handle } : null;
  }

  /** The root behind the document being shown. Or null. */
  async function rootOfDoc() {
    const id = docId();
    const was = id ? await kv.opened.get(id) : null;
    return rootById(was?.rootId);
  }

  /**
   * The root the worker named, or failing that the one behind the document being shown. The
   * worker names it when it can -- a link into another folder is not the document on screen --
   * and a page that is shown a lapsed folder on reload has only its own id to go by.
   */
  async function needsPermission(rootId) {
    pending = (await rootById(rootId)) ?? (await rootOfDoc());
    if (pending) for (const fn of askers) fn({ name: pending.name });
  }

  // --- the page's lifecycle ------------------------------------------------

  let watching = null; // { start, off }: what to subscribe again after a restore

  // A page in the back/forward cache is neither closed nor running, and its timers stop. The
  // worker would let the document go after 30 s; `bye` says so now, and also stops the worker
  // sending events to a page that cannot hear them.
  const onPageHide = () => inner.bye();
  const onPageShow = (e) => {
    // Not `persisted`: a page being shown for the first time has said hello already.
    if (!e.persisted) return;
    port.postMessage({ t: 'hello', doc: docId() });
    // `bye` stopped the worker's watch, and the file may have changed while the page slept.
    if (watching) {
      watching.start();
      watching.cbs.onEvent({ type: 'change' });
    }
  };
  win.addEventListener?.('pagehide', onPageHide);
  win.addEventListener?.('pageshow', onPageShow);

  return {
    ...inner,

    async doc(baseline) {
      try {
        return await inner.doc(baseline);
      } catch (err) {
        if (err?.name === 'NeedsPermission') await needsPermission(err.rootId);
        throw err;
      }
    },

    // A link into a folder whose grant has lapsed is refused like a reload is. The page stays on
    // the document it had, and the button asks for the folder the link was into; once granted,
    // opening the link again is the page's to do.
    async open(path) {
      try {
        return await inner.open(path);
      } catch (err) {
        if (err?.name === 'NeedsPermission') await needsPermission(err.rootId);
        throw err;
      }
    },

    watch(cbs) {
      const mine = { cbs, off: null };
      mine.start = () => {
        mine.off = inner.watch({
          onEvent: cbs.onEvent,
          onLive: (on, why, needs) => {
            if (!on && needs === 'permission') needsPermission();
            cbs.onLive(on, why);
          },
        });
      };
      mine.start();
      watching = mine;
      return () => {
        if (watching === mine) watching = null;
        mine.off();
      };
    },

    /**
     * Hear that the document cannot be read until the user says so. `fn({ name })` gets the
     * name of the folder to ask for, for a button that says what it is asking about. Returns the
     * function that stops listening.
     */
    onNeedsPermission(fn) {
      askers.add(fn);
      return () => askers.delete(fn);
    },

    /**
     * Ask the user for the folder again. Call it from the click on the button, and nothing
     * before it that waits: `requestPermission` is refused without a gesture. Answers whether it
     * was granted; the page then loads and watches again, as it does after `open`.
     */
    async reopen() {
      const root = pending ?? (await rootOfDoc());
      if (!root) return false;
      if ((await root.handle.requestPermission({ mode: 'read' })) !== 'granted') return false;
      // The worker asks for itself before it believes this: it is the one that will read.
      if (!(await call('grant', root.rootId))) return false;
      pending = null;
      return true;
    },

    // What the welcome offers. The handles go to the worker as they are -- a `FileSystemHandle`
    // survives `postMessage` -- and it is the worker that keeps them, so two tabs picking the same
    // folder at once cannot each write a root.
    /** A folder or file handle from a picker or a drop. Answers `{ rootId, name, kind }`. */
    addRoot: (handle) => call('addRoot', handle),
    /** A `File` that came with no handle. Answers the path to `open`. */
    addDrop: (file) => call('addDrop', file),

    /** Stop pinging and close the port. A page never needs this; a test does. */
    close() {
      clearInterval(pinger);
      win.removeEventListener?.('pagehide', onPageHide);
      win.removeEventListener?.('pageshow', onPageShow);
      port.close?.();
    },
  };
}
