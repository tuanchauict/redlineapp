// Snapshot store: keeps content-addressed copies of every version of a file we
// have ever seen, plus the reading state that goes with them — the "baseline"
// pointer (the version the user has already read), which changes have been
// checked off, and what the document was last compared against. Lives outside
// the project so it never pollutes the repo.
//
// Reaches the disk through a platform (see ./platform.js) rather than node, so
// that the same store runs in the CLI's server process and inside the desktop
// app's webview, where there is no node. That is also why every method here is
// async: a webview cannot read a file synchronously, and writing the store
// twice to spare the CLI an await would have been the worse trade.
import { hashContent, docKey, byteLength } from '../core/hash.js';

// Re-exported because this is where callers have always reached for it, and
// because a snapshot's name belongs to the store conceptually even though the
// digest itself now lives somewhere the diff can also reach. See ./hash.js.
export { hashContent };

const MAX_HISTORY = 100;

// An object younger than this is never swept. `record` writes the object first and the index
// that names it second, so a sweep in another process can land between the two and find an
// object nobody references yet. Ten minutes is far longer than that gap and far shorter than
// anything worth keeping a stray object for.
const GC_GRACE_MS = 10 * 60 * 1000;

// How long to wait before reading an index that would not parse a second time. A writer from
// before writes were atomic can leave one half-written, and half-written is a moment, not a state.
const REREAD_MS = 50;

// How many checked-off changes to remember per document. A key names a change
// by its content, so one goes dead the moment that wording is edited again —
// and a dead key costs a string. Cheaper to let them age out of a bounded list
// than to work out on every read which are still live, which would throw away
// the marks on one baseline the moment you looked at the document against
// another.
const MAX_ACKED = 400;

// A check-off names the version it was made against, and that is all the
// hash in it is ever used for — but it arrives from the page, and it becomes a
// path under objects/. Anything not shaped like one of ours is not kept.
const VERSION = /^[0-9a-f]{16}$/;
const BLOCK = /^[0-9a-f]{10}$/;

/**
 * Where the store lives.
 *
 * A store left under the app's old name is moved across the first time one is
 * found. It holds every snapshot of every file ever read and every read mark on
 * them, and a rename of the app is no reason to start that again from nothing —
 * nor to leave two stores lying about, which is what reading the old one where
 * it lay would have meant. A move that cannot be made (a permission, a mount)
 * is not worth failing over: the old directory goes on being used in place.
 */
export async function storeRoot(platform) {
  const override = platform.env('REDLINE_HOME');
  if (override) return override;
  const home = await platform.homeDir();
  const dir = platform.join(home, '.redline');
  const legacy = platform.join(home, '.md-reader');
  if ((await platform.exists(legacy)) && !(await platform.exists(dir))) {
    if (!(await platform.rename(legacy, dir))) return legacy;
  }
  return dir;
}

export class DocStore {
  /**
   * Open the store for one document.
   *
   * A factory rather than a constructor because opening it reads the disk, and
   * a constructor cannot wait. Everything the store needs to answer from
   * memory is loaded here, so the methods that only change state -- setting a
   * baseline, checking a change off -- stay a single write.
   */
  static async open(absPath, platform) {
    const root = await storeRoot(platform);
    const store = new DocStore();
    store.platform = platform;
    store.root = root;
    store.objects = platform.join(root, 'objects');
    store.docs = platform.join(root, 'docs');
    store.abs = absPath;
    store.file = platform.join(store.docs, docKey(absPath) + '.json');

    await platform.mkdirp(store.objects);
    await platform.mkdirp(store.docs);
    const { raw, data } = await store.#load();
    store.#known = raw;
    store.data = data;
    // An index written before versions were kept one to a content may hold the
    // same one twice; repairing it on open is cheaper than every reader of the
    // list having to allow for it.
    await store.#update(() => store.#collapseDuplicates());
    return store;
  }

  // What this process last read from the index file or wrote to it, as text. "Has another process
  // written?" is then a comparison and not a guess.
  #known = null;
  #mtime = null;
  #drifted = false;
  // Changes to the index run one at a time. Each is a read, an edit and a write, and two of them
  // interleaved in one process would lose one just as two processes can.
  #queue = Promise.resolve();

  #parse(raw) {
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data.history)) return data;
    } catch {
      /* first run for this document, or an index we cannot use */
    }
    return null;
  }

  /**
   * The index as it is on disk now. One that exists and will not parse is read once more after a
   * moment, and then taken for a first run, which is what it always was: the usual cause is a
   * writer caught between truncating the file and filling it.
   */
  async #load() {
    let raw = await this.platform.readText(this.file);
    let data = this.#parse(raw);
    if (!data && raw) {
      await new Promise((r) => setTimeout(r, REREAD_MS));
      raw = await this.platform.readText(this.file);
      data = this.#parse(raw);
    }
    return { raw, data: data ?? { path: this.abs, history: [], baseline: null } };
  }

  /**
   * Leave one entry per version, in the newest place each one appears.
   *
   * See `record` for why a version belongs in the list once. Anything a
   * duplicate had learned about its commit is carried over, so collapsing two
   * rows never loses the sha or the subject.
   */
  #collapseDuplicates() {
    const keep = new Map();
    for (const h of this.data.history) {
      const earlier = keep.get(h.hash);
      if (earlier) h.git ??= earlier.git;
      keep.set(h.hash, h);
    }
    if (keep.size === this.data.history.length) return false;
    this.data.history = this.data.history.filter((h) => keep.get(h.hash) === h);
    return true;
  }

  /**
   * Apply one change to the index as it is on disk, and write the result.
   *
   * Not to the copy this process read when it opened the file, which may be hours old: each
   * method passes what it means to do, and it is done to whatever the other processes have left,
   * so a mark-read made in one is not undone by a save in another. A change that answers `false`
   * leaves the file alone; the index is refreshed from disk either way. Returns what `change`
   * returns.
   *
   * What is left is a window of a few milliseconds, from this read to this write, in which
   * another process's change can be lost. A lock would close it and is not worth its cost: the
   * platform has no exclusive create, and a lock left by a crash needs a timeout of its own.
   */
  #update(change) {
    const run = async () => {
      const { raw, data } = await this.#load();
      // Folded into what is written below, so the poll would find nothing left to compare. Said
      // here instead, for the reader to announce.
      if (raw !== this.#known) this.#drifted = true;
      this.data = data;
      const result = change(data);
      if (result === false) {
        this.#known = raw;
        return result;
      }
      data.path = this.abs;
      if (data.history.length > MAX_HISTORY) data.history = data.history.slice(-MAX_HISTORY);
      const text = JSON.stringify(data, null, 2);
      await this.platform.writeText(this.file, text);
      this.#known = text;
      // Unknown rather than now: another process may write between our write and a stat, and a
      // stat taken then would pass for ours. The next poll reads once and compares the text.
      this.#mtime = null;
      return result;
    };
    const next = this.#queue.then(run);
    this.#queue = next.catch(() => {});
    return next;
  }

  /**
   * Has another process changed this document's index since this one last looked? If so the
   * index is reloaded and this answers true, once. Cheap enough to ask on every poll: the file
   * is read only when its modification time has moved, and only believed when its text differs
   * from what this process last read or wrote.
   */
  refresh() {
    const run = async () => {
      const m = await this.platform.modified(this.file);
      if (m !== this.#mtime) {
        this.#mtime = m;
        if (m != null) {
          const { raw, data } = await this.#load();
          if (raw !== this.#known) {
            this.#known = raw;
            this.data = data;
            this.#drifted = true;
          }
        }
      }
      const drifted = this.#drifted;
      this.#drifted = false;
      return drifted;
    };
    const next = this.#queue.then(run);
    this.#queue = next.catch(() => {});
    return next;
  }

  objectPath(hash) {
    return this.platform.join(this.objects, hash + '.md');
  }

  read(hash) {
    if (!hash) return Promise.resolve(null);
    return this.platform.readText(this.objectPath(hash));
  }

  /**
   * Write an object that is missing, and write again one that is old. Being on disk is not
   * enough to survive the index write that is about to name it: a version that comes back
   * after it was forgotten finds its object still there, unreferenced and as old as the day it
   * was written, and a sweep in another process would take it in between, leaving an index
   * that names nothing. Writing it makes it young again. Half the grace period is the margin,
   * so the two processes' clocks need not agree to the second.
   */
  async #writeObject(hash, text) {
    const dest = this.objectPath(hash);
    const at = await this.platform.modified(dest);
    if (at == null || Date.now() - at > GC_GRACE_MS / 2) await this.platform.writeText(dest, text);
  }

  get latest() {
    return this.data.history.at(-1) || null;
  }

  get baseline() {
    return this.data.baseline;
  }

  /**
   * Record the current content of the file. Adds to the history only when the
   * content actually differs from the newest snapshot. The very first snapshot
   * of a document also becomes its baseline, so opening a file for the first
   * time shows no spurious "everything changed".
   *
   * A version the document has held before is that same version come back, not
   * a new one, and it moves to the newest position rather than being appended
   * a second time. Everything here names a version by the hash of its content
   * — a `snap:` baseline, a clean-up, the object on disk — so a list holding
   * one twice would give two rows the same identity: the marks for "on disk"
   * and "read" would appear on both of them, and picking either would select
   * both. Undoing an edit is exactly how that happens.
   */
  async record(text, ts = Date.now()) {
    const hash = hashContent(text);
    // The object before the index that names it, never the other way round: an index that names
    // an object nobody wrote is a version that cannot be read, where an object no index names
    // yet is only litter, and gc leaves it alone while it is young. Writes replace a file whole,
    // so an object that exists is a whole one, and this need not read it back.
    await this.#writeObject(hash, text);

    let added = false;
    await this.#update((d) => {
      let changed = false;
      if (d.history.at(-1)?.hash !== hash) {
        const held = d.history.findIndex((h) => h.hash === hash);
        const entry = held < 0 ? { hash, size: byteLength(text) } : d.history.splice(held, 1)[0];
        // The time a version was last on disk, which for a version that has come
        // back is now: the list is read in time order, and this one is current.
        entry.ts = ts;
        d.history.push(entry);
        added = changed = true;
      }
      if (!d.baseline) {
        d.baseline = hash;
        changed = true;
      }
      return changed;
    });
    return { hash, added };
  }

  async setBaseline(hash) {
    // Moving the read mark used to be undoable, and the pointer it replaced was
    // kept for that. It is not information worth a field: the version it named
    // is still in the history, still referenced by gc(), and clicking its row
    // is the way back — one click, in a list that is open beside the document.
    await this.#update((d) => {
      d.baseline = hash;
      delete d.prevBaseline;
    });
  }

  /**
   * What this document was last compared against, as the selector the reader
   * speaks ('read' | 'git:HEAD' | 'snap:<hash>'), or null if it has never been
   * chosen.
   *
   * Not to be confused with `baseline` above, which is a content hash: the
   * version counted as read. This is the *choice of what to measure from*, and
   * 'read' is one of the things it can be. Picking a version out of the history
   * is a reading position as much as a scroll offset is, and losing it on every
   * restart meant finding the same version in the list again every morning.
   *
   * It lives here rather than in the page's own storage because the page does
   * not know which file it is showing until the document arrives — asking later
   * would mean a first paint against the wrong baseline and a visible
   * correction — and because the browser tab and the app's webview are separate
   * origins, which would have given one file two memories.
   */
  get compare() {
    return this.data.compare ?? null;
  }

  /** Remember a comparison. A no-op, and no write, when it is the one already held. */
  async setCompare(id) {
    return this.#update((d) => {
      if ((d.compare ?? null) === (id ?? null)) return false;
      d.compare = id ?? null;
      return true;
    });
  }

  /**
   * The changes marked checked, oldest mark first, as their keys.
   *
   * Separate from the baseline on purpose. Marking a version read says "I have
   * seen all of this", and moves what everything is measured from; checking one
   * change off says only "I have seen that bit" — the file has still moved, and
   * the rest of what moved is still worth marking.
   */
  get acked() {
    return this.ackRecords.map((a) => a.key);
  }

  /**
   * The same list as records: `{ key, at, block }`, where `at` is the version
   * the change was checked off in and `block` names the file's side of it in
   * that version. Together they find the text you read again, by splitting a
   * snapshot the store already holds — so a check-off stays a few bytes, and
   * nothing of the document is copied into the one part of the store that is
   * not already a snapshot.
   *
   * A bare string is a check-off made before they carried a version. It is
   * read as a record with neither, which behaves exactly as it always did,
   * rather than being dropped: losing every mark on upgrade is not a migration.
   */
  get ackRecords() {
    if (!Array.isArray(this.data.acked)) return [];
    return this.data.acked
      .map((a) => (typeof a === 'string' ? { key: a } : a))
      .filter((a) => typeof a?.key === 'string');
  }

  /**
   * Check one change off, or bring it back. Returns the keys as they now stand.
   *
   * `at` and `block` are what the change was when it was checked (see
   * `ackRecords`). A version this history does not hold is not recorded: it
   * could not be read back, and it is about to be used to name a file.
   */
  async setAcked(key, on, { at, block } = {}) {
    // Re-marking moves a key to the end rather than leaving it where it was, so
    // the oldest mark is always the one the cap drops.
    await this.#update((d) => {
      const next = this.ackRecords.filter((a) => a.key !== key); // `this.data` is `d` here
      if (on) {
        const held = VERSION.test(at ?? '') && d.history.some((h) => h.hash === at);
        next.push(held && BLOCK.test(block ?? '') ? { key, at, block } : { key });
      }
      d.acked = next.slice(-MAX_ACKED);
    });
    return this.acked;
  }

  /** Bring every checked change back. Nothing else here is undone in bulk. */
  async clearAcked() {
    await this.#update((d) => {
      if (!this.ackRecords.length) return false;
      d.acked = [];
    });
    return this.acked;
  }

  /** History newest-first, excluding the current version. */
  snapshots() {
    return this.data.history.slice().reverse();
  }

  /**
   * The commits already folded into this history. A file goes on being
   * committed to while the reader is not looking at it, so the import is not a
   * one-off — this is what lets a later open read only what is new.
   */
  get gitSeen() {
    return new Set(this.data.gitSeen ?? []);
  }

  /**
   * Fold a file's committed versions into its history — the versions that
   * existed before Redline ever saw the file, and any committed since it last
   * did. `versions` is oldest-first, each `{ text, ts, git: { sha, subject } }`.
   *
   * Nothing already recorded is disturbed and the baseline is left where it
   * stands: this adds versions to compare against, it does not decide that you
   * have or have not read any of them. Returns how many were new.
   */
  async importGit(versions) {
    if (!versions.length) return 0;

    // Objects first, for the reason `record` gives. Every one is looked for rather than only
    // the ones this process does not list: another process may have forgotten a version since.
    const entries = [];
    for (const v of versions) {
      const hash = hashContent(v.text);
      await this.#writeObject(hash, v.text);
      entries.push({ hash, ts: v.ts, size: byteLength(v.text), git: v.git });
    }

    let count = 0;
    await this.#update((d) => {
      const byHash = new Map(d.history.map((h) => [h.hash, h]));
      const fresh = [];
      for (const e of entries) {
        const seen = byHash.get(e.hash);
        if (seen) {
          // The same bytes we already hold: name the commit they came from
          // rather than keeping the content twice under two entries.
          seen.git ??= e.git;
          continue;
        }
        byHash.set(e.hash, e);
        fresh.push(e);
      }
      count = fresh.length;

      // Every commit offered is noted, whether or not its content was new, so
      // the next open does not read the same blobs again.
      d.gitSeen = [...new Set(d.gitSeen ?? []), ...versions.map((v) => v.git.sha)].slice(
        -MAX_HISTORY * 2,
      );
      // Commits already made when we first looked are older than anything we
      // watched, so they belong in front; ones made since belong wherever their
      // date puts them. Sorting covers both, and time order is the order the
      // history is read in.
      if (fresh.length) d.history = [...fresh, ...d.history].sort((a, b) => a.ts - b.ts);
    });
    return count;
  }

  /**
   * Forget the version `upto` and every version older than it. The newest is
   * never dropped: it is what everything else is compared against. Returns how
   * many versions were forgotten.
   */
  async prune(upto) {
    let dropped = 0;
    await this.#update((d) => {
      const idx = d.history.findIndex((h) => h.hash === upto);
      if (idx < 0 || idx === d.history.length - 1) return false;

      dropped = idx + 1;
      d.history = d.history.slice(idx + 1);
      const left = new Set(d.history.map((h) => h.hash));

      // A baseline whose version is gone cannot be diffed against any more. It
      // falls back to the oldest version still here rather than to the newest,
      // so tidying up never quietly hides a change you have not seen.
      if (!left.has(d.baseline)) d.baseline = d.history[0].hash;
      delete d.prevBaseline;
      // A remembered comparison against a version just forgotten is forgotten
      // with it, rather than left to be downgraded on every open from here on.
      // This is also what keeps gc() honest: a stored `snap:` is always a hash
      // the history still lists, so sweeping the history sweeps this too.
      if (d.compare?.startsWith('snap:') && !left.has(d.compare.slice(5))) d.compare = null;
    });
    return dropped;
  }

  /**
   * Drop object files no document references any more.
   *
   * A sweep of every document, not of one: the objects are shared, so only
   * reading all the indexes can say whether the last reference to a snapshot
   * has gone.
   *
   * An object younger than `GC_GRACE_MS` is kept whatever the indexes say. `record` writes the
   * object and then the index, and a sweep in another process can run in between; without this
   * the only protection was that one window collected and the rest did not.
   */
  static async gc(platform) {
    const root = await storeRoot(platform);
    const objects = platform.join(root, 'objects');
    const docs = platform.join(root, 'docs');

    let indexes;
    try {
      indexes = await platform.readDir(docs);
    } catch {
      return; // store not created yet
    }

    const referenced = new Set();
    for (const name of indexes) {
      if (!name.endsWith('.json')) continue;
      try {
        const d = JSON.parse(await platform.readText(platform.join(docs, name)));
        if (d.baseline) referenced.add(d.baseline);
        for (const h of d.history || []) referenced.add(h.hash);
        // A check-off reads its block back out of the version it was made in.
        // Forgetting that version from the list is tidying up; collecting the
        // object behind it would quietly turn every check-off made in it back
        // into "added the whole thing", for exactly the people who tidy up.
        for (const a of Array.isArray(d.acked) ? d.acked : []) {
          if (VERSION.test(a?.at ?? '')) referenced.add(a.at);
        }
      } catch {
        // An index we cannot read is not an index we can prove is empty, so
        // nothing is collected on its account.
        return;
      }
    }

    const now = Date.now();
    for (const name of await platform.readDir(objects)) {
      const hash = name.endsWith('.md') ? name.slice(0, -3) : name;
      if (referenced.has(hash)) continue;
      const file = platform.join(objects, name);
      // Gone already, or too new to say: either way not this sweep's to remove.
      const at = await platform.modified(file);
      if (at == null || now - at < GC_GRACE_MS) continue;
      await platform.remove(file);
    }
  }
}
