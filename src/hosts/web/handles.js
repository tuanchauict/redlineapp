// What the user has granted, and which document is which file: the web host's memory across
// visits.
//
// Two stores in IndexedDB (`idb.js` makes them) and nothing else:
//
//   roots    rootId -> { handle, name, kind }   a folder or a file the user handed over
//   opened   docId  -> { rootId, rel }          what a doc id means, so `?id=` outlives the tab
//
// A root is named by a random id and not by anything about the folder: the id is an identity,
// not a content hash, and the same folder granted twice is one root (`isSameEntry`), so it keeps
// its history. A document's path is `web:<rootId>/<rel>`, and its doc id is the reader's usual
// hash of that, so the id on a reload is the id it had.
//
// Only the worker writes. The page opens the same stores to read -- to hold the handle it must
// ask permission on, which has to happen in a window and from a click -- and posts a handle to
// the worker when it has a new one, rather than writing it itself, so that two tabs picking the
// same folder at once are serialised by one thread instead of racing in two.
import { makePaths } from '../../core/paths.js';

const paths = makePaths('/');

/** `web:<rootId>/<rel>`, the path of a file inside a root. */
export const webPath = (rootId, rel) => `web:${rootId}/${rel}`;

/** The parts of a `web:` path, or null for any other kind. */
export function parseWebPath(abs) {
  const m = /^web:([^/\\]+)\/(.+)$/.exec(abs ?? '');
  return m ? { rootId: m[1], rel: m[2] } : null;
}

/**
 * A document that cannot be shown until the user says so. The grant on a folder outlives the tab
 * only if the browser is generous, and after a reload it often has to be asked for again --
 * from a click, in a window, so not from here. The page turns this into the Reopen button.
 */
export class NeedsPermission extends Error {
  constructor(name) {
    super(`Redline needs your permission to read ${name} again`);
    this.name = 'NeedsPermission';
    this.root = name;
  }
}

/**
 * A page that was told to show a document and has none to show: it came with no `?id=`, or the
 * id is one this browser never opened, or the folder behind it was denied or forgotten. The page
 * answers with the welcome and drops the id from its address (010 §8). Not `Closed`, which is a
 * document that *was* there -- the reader's word, and the page's cue to say it is gone.
 */
export class NoDocument extends Error {
  constructor(message = 'No document is open') {
    super(message);
    this.name = 'NoDocument';
  }
}

/**
 * @param {object} deps
 * @param {import('./kv-files.js').Kv} deps.roots   The `roots` store.
 * @param {import('./kv-files.js').Kv} deps.opened  The `opened` store.
 * @param {() => string} [deps.randomId]
 */
export function createHandles({
  roots,
  opened,
  randomId = () => globalThis.crypto.randomUUID(),
}) {
  // Live handles, kept once read: a poll asks for its root every 1.5 s, and a read of the store
  // for each would deserialise a handle every time. Only this process adds a root, so there is
  // nothing in here that another could have made stale.
  const live = new Map();
  // What the labels are made of: `{ name, kind }` by root. Sync, because a label is asked for in
  // the middle of building a document, and filled by `root`, which the platform has called to
  // read the file by then.
  const info = new Map();

  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  const same = async (a, b) => {
    try {
      return await a.isSameEntry(b);
    } catch {
      return false;
    }
  };

  async function root(rootId) {
    if (live.has(rootId)) return live.get(rootId);
    const rec = await roots.get(rootId);
    if (!rec) return null;
    live.set(rootId, rec.handle);
    info.set(rootId, { name: rec.name, kind: rec.kind });
    return rec.handle;
  }

  return {
    root,

    /**
     * Keep a handle the user has just granted. Answers `{ rootId, name, kind }`, which is the
     * existing root's when the same folder or file is already there.
     */
    addRoot: (handle) =>
      serial(async () => {
        for (const rootId of await roots.keys('')) {
          const rec = await roots.get(rootId);
          if (rec?.kind === handle.kind && (await same(rec.handle, handle))) {
            live.set(rootId, rec.handle);
            info.set(rootId, { name: rec.name, kind: rec.kind });
            return { rootId, name: rec.name, kind: rec.kind };
          }
        }
        const rootId = randomId();
        const rec = { handle, name: handle.name, kind: handle.kind };
        await roots.put(rootId, rec);
        live.set(rootId, handle);
        info.set(rootId, { name: rec.name, kind: rec.kind });
        return { rootId, name: rec.name, kind: rec.kind };
      }),

    /** The root's name as the registry last saw it, or null. For labels. */
    nameOf: (rootId) => info.get(rootId)?.name ?? null,

    /**
     * Whether a root may be read now: what `queryPermission` says (`granted`, `prompt`,
     * `denied`), or `gone` for a root the registry does not have or a handle that cannot be
     * asked. Never asks the user -- that is `requestPermission`, which only a page can call.
     */
    async permission(rootId, mode = 'read') {
      const handle = await root(rootId);
      if (!handle) return 'gone';
      try {
        return await handle.queryPermission({ mode });
      } catch {
        return 'gone';
      }
    },

    /** Remember that this doc id is this file, for the reload that comes back with `?id=`. */
    rememberOpened: (id, rootId, rel) => opened.put(id, { rootId, rel }),

    /** What a doc id was, or null if the registry never saw it. */
    openedAs: async (id) => (await opened.get(id)) ?? null,

    /**
     * How a path is shown: the root's name in front, so a folder's files read as part of it and a
     * dropped file says what it is.
     */
    label(abs) {
      const w = parseWebPath(abs);
      if (w) {
        const { name = 'folder', kind } = info.get(w.rootId) ?? {};
        // A file granted by itself has no folder around it to name.
        if (kind === 'file') return { pathLabel: w.rel, dirLabel: '' };
        const dir = paths.dirname('/' + w.rel).slice(1);
        return { pathLabel: `${name}/${w.rel}`, dirLabel: dir ? `${name}/${dir}` : name };
      }
      if (abs?.startsWith('drop:')) {
        return { pathLabel: `drop: ${abs.slice('drop:'.length)}`, dirLabel: 'drop:' };
      }
      return { pathLabel: abs, dirLabel: paths.dirname(abs) };
    },
  };
}
