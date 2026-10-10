// The store's file operations over a key-value store: what lets the snapshot store live in
// IndexedDB, where there is no directory to write into.
//
// Only the store's own files go through here -- `objects/<hash>.md`, `docs/<key>.json`, whatever
// sits under one root -- and never the document being read. That is invariant 4 kept by
// construction: this module has no way to name a path outside its root, and refuses one.
//
// A key is the whole path and a value is `{ text, mtime }`. Directories are not stored: a key
// `/redline/objects/ab12.md` is enough to make `objects` exist, so there is nothing to create
// and nothing to leave behind when the last file in one goes.
//
// The kv it is given has five calls, and `idb.js` is the one that matters:
//
//   get(key)            the value, or undefined
//   put(key, value)     replaces the value whole
//   del(key)            and is no error when there is nothing there
//   keys(prefix)        every key that starts with `prefix`, in order
//   tx(fn)              runs `fn(kv)` as one atomic step and answers what `fn` answers. `kv` has
//                       `get`, `put`, `del` and `keys` and is bound to that step; if `fn` throws,
//                       none of what it did is kept.
//
// `fn` may only wait for calls made on the kv it is handed. IndexedDB ends a transaction as soon
// as it has no request pending, so a wait on anything else (a timer, a fetch, another
// transaction) leaves the next request to throw `TransactionInactiveError`. Nothing in here
// waits on anything else. The `Map` the tests use would not notice if something did, so that is
// held by how each `fn` below is written -- a get or two, a put, a del -- and not by a test.

/**
 * @typedef {object} Kv
 * @property {(key: string) => Promise<any>} get
 * @property {(key: string, value: any) => Promise<void>} put
 * @property {(key: string) => Promise<void>} del
 * @property {(prefix: string) => Promise<string[]>} keys
 * @property {<T>(fn: (kv: Omit<Kv, 'tx'>) => Promise<T>) => Promise<T>} tx
 */

/**
 * @param {Kv} kv
 * @param {string} root  Where the store lives, as the platform answers `REDLINE_HOME`.
 * @returns {Pick<import('../../reader/platform.js').Platform,
 *   'readText' | 'writeText' | 'mkdirp' | 'readDir' | 'remove' | 'rename' | 'exists' | 'modified'>}
 */
export function createKvFiles(kv, root) {
  const base = root.replace(/\/+$/, '');

  // A path the store may name: `root` and what is under it. Not a prefix match on the string,
  // or `/redlinex` would be taken for part of `/redline`.
  const inside = (p) => p === base || p.startsWith(base + '/');
  const dir = (p) => {
    if (!inside(p)) throw new Error(`not under ${base}: ${p}`);
    return p.replace(/\/+$/, '');
  };
  // A file is never the root itself, which is a directory.
  const file = (p) => {
    if (!p.startsWith(base + '/')) throw new Error(`not under ${base}/: ${p}`);
    return p;
  };

  // `modified` has to move on every write: the store's `refresh()` reads an index only when it
  // does, so two writes in one millisecond would look like one. That matters wherever two
  // readers share one database, which is what a page without `SharedWorker` is. `previous + 1`
  // also keeps it moving if the clock steps back.
  const stamp = (previous) => Math.max(Date.now(), (previous?.mtime ?? 0) + 1);

  return {
    async readText(p) {
      return (await kv.get(file(p)))?.text ?? null;
    },

    async modified(p) {
      return (await kv.get(file(p)))?.mtime ?? null;
    },

    // One `put`, so the file is replaced whole, as the contract requires. The read of the
    // previous record, for its timestamp, is in the same transaction: two tabs writing at once
    // are serialised by it, and neither takes a stamp the other has already used.
    async writeText(p, text) {
      const key = file(p);
      return kv.tx(async (t) => {
        await t.put(key, { text, mtime: stamp(await t.get(key)) });
      });
    },

    // Directories are implicit, so there is nothing to make.
    async mkdirp(p) {
      dir(p);
    },

    // The immediate children, as names. A key two levels down names the directory between,
    // once, however many files are in it. A directory with nothing in it is not there, which
    // reads as empty here, where node would throw.
    async readDir(p) {
      const prefix = dir(p) + '/';
      const names = (await kv.keys(prefix)).map((k) => k.slice(prefix.length).split('/')[0]);
      return [...new Set(names)];
    },

    async remove(p) {
      await kv.del(file(p));
    },

    // A file moves in one transaction, so nobody sees it in both places or in neither. A
    // directory is not moved, and nor is anything missing: a directory has no record of its own
    // to carry across, and the one caller that wants one moved -- `storeRoot`, from the app's
    // old name -- cannot reach here, because the platform answers `REDLINE_HOME` first.
    async rename(from, to) {
      const a = file(from);
      const b = file(to);
      if (a === b) return (await kv.get(a)) != null;
      return kv.tx(async (t) => {
        const record = await t.get(a);
        if (record == null) return false;
        await t.put(b, { text: record.text, mtime: stamp(await t.get(b)) });
        await t.del(a);
        return true;
      });
    },

    // A directory exists when something is under it, which is as much as a directory is here.
    async exists(p) {
      const key = dir(p);
      if ((await kv.get(key)) != null) return true;
      return (await kv.keys(key + '/')).length > 0;
    },
  };
}
