// The page's end of the web app: find the reader, talk to it, and say what the user has to do
// when it cannot go on without them.
//
// The reader is in a SharedWorker (worker.ts), one for every tab of this origin; where there is
// none, it is the same code in this page, behind a MessageChannel. Either way `createRpcBackend`
// does what it does for every host that is not in the page's own heap, and this wraps it with
// the four things a browser tab has that the others do not:
//
//   - the page's lifecycle. A tab that goes into the back/forward cache is not closed and not
//     alive, and the worker has to be told, so that it neither holds the document for ever nor
//     forgets the tab when it comes back
//   - permission. A file the user granted last week may have to be granted again, and only a
//     page, from a click, can ask (`reopen`)
//   - the ways to open something that are not a link: a file, a drop (`welcome.ts`)
//   - the files the tab has open, for the left column, which a window has a shell to keep
//     (`openFiles`)
//
// Bundled to public/vendor/backend-web.js, and loaded only when `host.js` has said this is the
// web app, so no other build downloads it.
import { createRpcBackend } from '../../rpc/client.js';
import type { RpcBackend } from '../../rpc/client.js';
import { createIdbKv } from './idb.js';
import { parseWebPath } from './handles.js';
import { createOpenFiles, storageOf } from './open-files.js';
import { mountWelcome } from './welcome.js';
import type { Welcome, WelcomeDeps } from './welcome.js';
import type { Kv } from './kv-files.js';
import type { WatchHandlers } from '../../contract/seam.js';

/** How often to tell the worker this page is still here. It lets go of a document after 30 s. */
export const PING_MS = 10_000;

/** What a click on a link to another file says, in a web app that opens one file at a time. */
export const LINK_NOTE =
  'The web app opens one file at a time, so links to other files do not open here. ' +
  'The Mac app follows them.';

/**
 * A file beside `base`, asked for the way `base` was: with the same query.
 *
 * The staged page asks for every file as `name?v=<build>` and lets the browser keep it for a year,
 * and a relative URL does not take its base's query: `new URL('./b.js', 'http://h/a.js?v=1')` is
 * `http://h/b.js`. A worker found that way would be the one file of the page held under a name
 * that never changes, and the new page would be given the old reader for as long as the cache
 * liked. With no query on `base`, which is every host but the web app's, there is none to copy
 * and the URL is what it always was.
 *
 * `base` defaults to this file, which is `vendor/backend-web.js` once bundled.
 */
export function sibling(name: string, base: string = import.meta.url): URL {
  const url = new URL(name, base);
  url.search = new URL(base).search;
  return url;
}

// The bundle beside this one. Not an import: the page must not download the reader unless it
// has to.
const WORKER_URL = sibling('./reader-worker.js');

// Written onto the window by the staged shim, and absent from a page nobody built. A `var`, so
// that it is a property of `globalThis`, which is where `workerName` reads it from.
declare global {
  var __REDLINE_VERSION: string | undefined;
}

/**
 * What the page calls its SharedWorker. One is found by its URL and its name, and a tab left open
 * on the old build keeps the old reader alive: a tab opened on the new one would join it -- new
 * page code against old reader code, until every tab closed. The URL differs between builds
 * because it has the page's `?v=` in it (`sibling`); the build is in the name as well, so that
 * the two builds get a worker each without leaning on one thing alone. Two
 *
 * The build is the version *and a hash of the bundles*, `0.7.0+3fa9c2d1e0b4`. The version alone
 * does not change between rebuilds at one version -- every round of `npm run webapp`, a redeploy
 * of a release -- and each of those is new reader code that a tab left open would keep alive for
 * the new tabs to join. It is on the window because the staged shim puts it there
 * (`stage-page.mts`, after `host.js`); a page without one is a page nobody built, which is the
 * only time it says `dev`.
 */
export const workerName = (g: { __REDLINE_VERSION?: string } = globalThis): string =>
  `redline@${g.__REDLINE_VERSION ?? 'dev'}`;

/** How a page reaches its reader: the port, and who to tell when the reader cannot start. */
export interface Connection {
  port: MessagePort;
  onError: (fn: (why: string) => void) => void;
}

/** Join the worker, or be one. */
export async function openPort(): Promise<Connection> {
  if (typeof globalThis.SharedWorker === 'function') {
    const worker = new globalThis.SharedWorker(WORKER_URL, { type: 'module', name: workerName() });
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
  // Each tab then has its own reader over the one IndexedDB store (docs/architecture.md).
  const { createWebHost } = await import(WORKER_URL.href);
  const { port1, port2 } = new MessageChannel();
  createWebHost().connect(port2);
  return { port: port1, onError: () => {} };
}

export interface WebBackendOptions {
  /** The document being shown, read per call. */
  docId: () => string | null;
  /** How to reach the reader. Default: `openPort`. */
  connect?: () => Promise<Connection>;
  /**
   * The IndexedDB stores, read here to hold the handle a permission prompt needs. Default: the
   * real ones.
   */
  stores?: { roots: Kv; opened: Kv };
  /** What fires `pagehide` and `pageshow`. Default: `window`. */
  win?: typeof globalThis;
  pingMs?: number;
}

/**
 * What the web app's page gets: the rpc backend without its `call`, which stays in this file,
 * plus what only a browser tab has.
 */
export interface WebBackend extends Omit<RpcBackend, 'call'> {
  /** Hear that the document cannot be read until the user says so; `name` is the folder's. */
  onNeedsPermission(fn: (info: { name: string }) => void): () => void;
  /**
   * Ask the user for the folder again. Call it from the click; answers whether it was granted.
   */
  reopen(): Promise<boolean>;
  /** A file handle from a picker or a drop. Answers `{ rootId, name, kind }`. */
  addRoot(handle: FileSystemHandle): Promise<{ rootId: string; name: string; kind: string }>;
  /** A `File` that came with no handle. Answers the path to `open`. */
  addDrop(file: File): Promise<string>;
  /** The doors of the page's empty state; `sync` on what comes back says whether to ask again. */
  welcome(hooks: Omit<WelcomeDeps, 'backend' | 'win'>): Welcome;
  /** Why a link out of this document will not open, or null if it will. */
  linkNote(path: string | null | undefined): Promise<string | null>;
  openFiles: ReturnType<typeof createOpenFiles>;
  /** Stop pinging and close the port. */
  close(): void;
}

export async function createWebBackend({
  docId,
  connect = openPort,
  stores,
  win = globalThis,
  pingMs = PING_MS,
}: WebBackendOptions): Promise<WebBackend> {
  const kv = stores ?? { roots: createIdbKv('roots'), opened: createIdbKv('opened') };
  const { port, onError } = await connect();

  let disconnect: (why?: string) => void = () => {};
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
  // As for the worker's sweeper: Node, in the tests, hands back a `Timeout`.
  (pinger as unknown as { unref?(): void }).unref?.();

  // --- permission ----------------------------------------------------------

  const askers = new Set<(info: { name: string }) => void>();
  // What the page would have to ask for, held from the moment it is known to be needed until the
  // click that asks: `requestPermission` wants a user gesture, and a gesture is not for waiting
  // on a database read.
  let pending: { rootId: string; name: string; handle: any } | null = null;

  /** A root, with the handle to ask about it. Or null. */
  async function rootById(rootId?: string | null) {
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
  async function needsPermission(rootId?: string) {
    pending = (await rootById(rootId)) ?? (await rootOfDoc());
    if (pending) for (const fn of askers) fn({ name: pending.name });
  }

  // --- the page's lifecycle ------------------------------------------------

  // What to subscribe again after a restore.
  let watching: { start(): void; off: (() => void) | null; cbs: WatchHandlers } | null = null;

  // A page in the back/forward cache is neither closed nor running, and its timers stop. The
  // worker would let the document go after 30 s; `bye` says so now, and also stops the worker
  // sending events to a page that cannot hear them.
  const onPageHide = () => inner.bye();
  const onPageShow = (e: PageTransitionEvent) => {
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

  const api: WebBackend = {
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
      const mine: NonNullable<typeof watching> = {
        cbs,
        off: null,
        start: () => {
          mine.off = inner.watch({
            onEvent: cbs.onEvent,
            onLive: (on, why, needs) => {
              if (!on && needs === 'permission') needsPermission();
              cbs.onLive(on, why);
            },
          });
        },
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
    // file at once cannot each write a root.
    /** A file handle from a picker or a drop. Answers `{ rootId, name, kind }`. */
    addRoot: (handle) => call('addRoot', handle),
    /** A `File` that came with no handle. Answers the path to `open`. */
    addDrop: (file) => call('addDrop', file),

    /**
     * The ways to open something from the page's empty state, and the drops onto the window.
     * The page calls this only when it is here -- no other backend has one -- so that the welcome
     * exists only in the web app, and `sync` on what comes back says whether to ask again.
     */
    welcome: (hooks) => mountWelcome({ backend: api, win, ...hooks }),

    /**
     * Why a link out of this document will not open, or null if it will. A file granted or
     * dropped has no folder around it to read the link from, and the page would otherwise be
     * silent: the worker refuses and the click does nothing. The web app opens nothing else, so
     * the note says where links are followed rather than how to make them work here. A folder
     * granted before the web app took only files still follows its own.
     */
    async linkNote(path) {
      const dropped = path?.startsWith('drop:');
      const rooted = parseWebPath(path);
      const rec = rooted ? await kv.roots.get(rooted.rootId) : null;
      return dropped || rec?.kind === 'file' ? LINK_NOTE : null;
    },

    /**
     * The files this tab has open, which the left column lists as the desktop app lists its
     * tabs (`open-files.ts`). Off `win`'s storage, so a test's window keeps a list in memory.
     */
    openFiles: createOpenFiles({
      tab: storageOf(win, 'sessionStorage'),
      shared: storageOf(win, 'localStorage'),
    }),

    /** Stop pinging and close the port. A page never needs this; a test does. */
    close() {
      clearInterval(pinger);
      win.removeEventListener?.('pagehide', onPageHide);
      win.removeEventListener?.('pageshow', onPageShow);
      port.close?.();
    },
  };
  return api;
}
