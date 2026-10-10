// The web app's side of the platform contract: what the reader runs on in a browser with no
// server and no node.
//
// Three kinds of path, and each one is somewhere else:
//
//   web:<rootId>/<rel>   a file inside a folder (or a file) the user granted. Read through its
//                        handle, one segment at a time. Never written.
//   drop:<name>          a file that was dropped or picked with no handle, read once. Never
//                        written.
//   /redline/...         the snapshot store, in IndexedDB through kv-files.js. The only place
//                        anything is written, and the only place anything can be.
//
// That last sentence is invariant 4 -- the file being read is never written, and neither is
// anything next to it -- and here it is enforced where the writes arrive rather than promised by
// whoever sends them: a write to anything but the store throws, whatever the reader meant.
//
// Where handles and dropped files are kept is not this file's business (the registry is a
// module of its own), so what looks them up is handed in.
import { makePaths } from '../../core/paths.js';
import { createKvFiles } from './kv-files.js';

/** Where the store lives. `REDLINE_HOME` answers it, so `storeRoot` lands here and nowhere else. */
export const STORE_ROOT = '/redline';

const paths = makePaths('/');

// What a handle says when the file is not there to be read. Anything else -- a permission that
// has been taken back -- is not "missing", and is left to be seen as what it is. `NotReadable` is
// a file that changed between being opened and being read, which is how an editor's save looks
// from here; the reader treats a null as "back in a moment" and reads again.
const NOT_THERE = new Set(['NotFoundError', 'TypeMismatchError', 'NotReadableError']);

const notThere = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (NOT_THERE.has(err?.name)) return null;
    throw err;
  }
};

/**
 * @param {object} deps
 * @param {import('./kv-files.js').Kv} deps.kv  The `files` store, as `idb.js` makes it.
 * @param {(rootId: string) => object | null | Promise<object | null>} deps.root
 *   The granted directory or file handle for a root, or null for one that is not known. May wait.
 * @param {Map<string, { text: () => Promise<string>, lastModified: number }>} deps.drops
 *   Dropped files by name, which is what follows `drop:`. A `File` is one.
 * @returns {import('../../reader/platform.js').Platform}
 */
export function createWebPlatform({ kv, root, drops }) {
  const store = createKvFiles(kv, STORE_ROOT);

  /**
   * Normalise `.` and `..` *after* the prefix, so that a path cannot climb out of the root it
   * names: `web:a/x/../../y` is `web:a/y`, and `drop:../x` is `drop:x`. Nothing is prepended to
   * a path that is not absolute -- there is no working directory to resolve against -- and two
   * spellings of one file must not survive this, since the store keys a document on the answer.
   */
  function resolve(p) {
    const prefix = /^(?:web:[^/\\]*|drop:)/.exec(p ?? '');
    if (!prefix) return paths.resolve(p);
    // Rooted for the walk, which is what stops a `..` at the prefix.
    const tail = paths.resolve('/' + p.slice(prefix[0].length)).slice(1);
    if (prefix[0] === 'drop:') return prefix[0] + tail;
    return tail ? `${prefix[0]}/${tail}` : prefix[0];
  }

  /** Which of the three kinds a path is, and the parts of it that kind needs. */
  function route(p) {
    const q = resolve(p);
    if (q.startsWith('drop:')) return { kind: 'drop', name: q.slice('drop:'.length) };
    if (q.startsWith('web:')) {
      const slash = q.indexOf('/');
      const end = slash < 0 ? q.length : slash;
      return { kind: 'web', rootId: q.slice('web:'.length, end), rel: q.slice(end + 1) };
    }
    if (q === STORE_ROOT || q.startsWith(STORE_ROOT + '/')) return { kind: 'store', path: q };
    return { kind: 'none' };
  }

  /** The store path `p` names, or an error: the one place a write is allowed. */
  function mine(what, p, rule = `Redline writes only under ${STORE_ROOT}/, never to a document`) {
    const r = route(p);
    if (r.kind !== 'store') throw new Error(`${what} ${p}: ${rule}`);
    return r.path;
  }

  /** The file handle a `web:` path names, or null. */
  async function handleOf({ rootId, rel }) {
    const top = await root(rootId);
    if (!top) return null;
    // A file that was granted by itself has no parent to walk from: it is its own name, and
    // nothing beside it.
    if (top.kind === 'file') return rel === top.name ? top : null;
    const names = rel.split('/').filter(Boolean);
    if (!names.length) return null;
    let dir = top;
    for (const name of names.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
    return dir.getFileHandle(names.at(-1));
  }

  /** `use` on the `File` behind a `web:` path, or null when there is none. */
  const onFile = (r, use) =>
    notThere(async () => {
      const handle = await handleOf(r);
      return handle ? use(await handle.getFile()) : null;
    });

  return {
    async readText(p) {
      const r = route(p);
      if (r.kind === 'store') return store.readText(r.path);
      if (r.kind === 'drop') return notThere(async () => (await drops.get(r.name)?.text()) ?? null);
      if (r.kind === 'web') return onFile(r, (file) => file.text());
      return null;
    },

    async modified(p) {
      const r = route(p);
      if (r.kind === 'store') return store.modified(r.path);
      if (r.kind === 'drop') return drops.get(r.name)?.lastModified ?? null;
      if (r.kind === 'web') return onFile(r, (file) => file.lastModified);
      return null;
    },

    async exists(p) {
      const r = route(p);
      if (r.kind === 'store') return store.exists(r.path);
      if (r.kind === 'drop') return drops.has(r.name);
      if (r.kind === 'web') return (await notThere(() => handleOf(r))) != null;
      return false;
    },

    // Listing a folder is for the welcome, which walks its own handle; the reader lists only
    // the store.
    async readDir(p) {
      return store.readDir(mine('readDir', p, `only ${STORE_ROOT}/ can be listed`));
    },

    async writeText(p, text) {
      return store.writeText(mine('writeText', p), text);
    },
    async mkdirp(p) {
      return store.mkdirp(mine('mkdirp', p));
    },
    async remove(p) {
      return store.remove(mine('remove', p));
    },
    // Both ends: a file may not be moved out of the store, or something else in over it.
    async rename(from, to) {
      return store.rename(mine('rename', from), mine('rename', to));
    },

    // The reader polls, and a poll finds what a watch would. Nothing is watched, which the
    // contract allows: a watch is only ever a hint.
    watch: async () => () => {},

    homeDir: async () => '',
    env: (name) => (name === 'REDLINE_HOME' ? STORE_ROOT : undefined),
    os: 'web',
    // No `spawn`, not one that throws: the reader reads the absence, and the payload's `caps`
    // say so.

    join: paths.join,
    dirname: paths.dirname,
    basename: paths.basename,
    resolve,
  };
}
