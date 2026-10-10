// The key-value store `kv-files.js` asks for, over IndexedDB.
//
// Kept small on purpose, because nothing here can be run without a browser: the tests import
// this file and never call it. It is meant to be checked by reading.
//
// One database, `redline`, with every object store the web app will use, made now so that the
// handle registry added later needs no schema upgrade:
//
//   files    path     -> { text, mtime }      the snapshot store, through kv-files.js
//   roots    rootId   -> { handle, name, kind }
//   opened   doc id   -> { rootId, rel }
//
// `indexedDB` is reached only when a call is made, never when this file is imported, so node
// can import it (the layering walk and the tests do) and a page with no IndexedDB fails at the
// first call, with a message, rather than at load.

const DB_NAME = 'redline';
const DB_VERSION = 1;
export const STORES = ['files', 'roots', 'opened'];

let opening = null;

function openDb() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) throw new Error('IndexedDB is not available here');
    const req = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    // Out-of-line keys: the path or the id is the key, and the value is stored as it is.
    req.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Let go when asked, or a later schema change in another tab waits on this one for good.
      // The next call opens it again.
      const release = () => {
        db.close();
        opening = null;
      };
      db.onversionchange = release;
      db.onclose = release;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  // A failed open is not kept, so that a later call tries again.
  opening.catch(() => (opening = null));
  return opening;
}

// A request as a promise. Settled in the request's own callback, where the transaction is
// still active, so whatever waits on it can issue the next request on the same transaction.
const reply = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

// The four calls on one object store, inside one transaction.
const bind = (store) => ({
  get: (key) => reply(store.get(key)),
  put: async (key, value) => void (await reply(store.put(value, key))),
  del: async (key) => void (await reply(store.delete(key))),
  // Every key that starts with `prefix`: the range from it to the same string with the highest
  // code unit after it. Keys are compared by code unit, as `startsWith` does.
  keys: (prefix) => reply(store.getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff'))),
});

/**
 * Run `fn` on one object store in one transaction, and answer once it has been *committed*.
 *
 * Not once the last request has succeeded: a write that the browser cannot keep (the quota, a
 * disk) fails at commit, after every request has said yes, and the store must not be told it was
 * written. `fn` is handed the store's calls and may wait only on them -- see kv-files.js.
 */
function transact(storeName, mode, fn) {
  return openDb().then((db) => {
    const t = db.transaction(storeName, mode);
    const committed = new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onabort = () => reject(t.error ?? new Error('transaction aborted'));
    });
    // Called now, in this turn, while the transaction is new. An async wrapper so that a throw
    // is a rejection like any other.
    const result = (async () => fn(bind(t.objectStore(storeName))))();
    // What `fn` had asked for is dropped if it fails. Throws if the transaction is already over.
    result.catch(() => {
      try {
        t.abort();
      } catch {
        /* finished already */
      }
    });
    return Promise.all([result, committed]).then(([value]) => value);
  });
}

/**
 * A key-value store over one of the object stores above.
 * @param {'files' | 'roots' | 'opened'} storeName
 * @returns {import('./kv-files.js').Kv}
 */
export function createIdbKv(storeName) {
  return {
    get: (key) => transact(storeName, 'readonly', (s) => s.get(key)),
    put: (key, value) => transact(storeName, 'readwrite', (s) => s.put(key, value)),
    del: (key) => transact(storeName, 'readwrite', (s) => s.del(key)),
    keys: (prefix) => transact(storeName, 'readonly', (s) => s.keys(prefix)),
    tx: (fn) => transact(storeName, 'readwrite', fn),
  };
}
