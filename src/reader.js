// The reader: the set of documents currently being read, and everything you
// can do to one of them.
//
// This is the whole back end. It knows nothing about http, and nothing about
// windows — it is the same object whether it is being driven by a browser over
// a socket or by a page that is holding it directly, which is the point. The
// CLI wraps it in a server (src/server.js) because a browser tab needs a URL
// to talk to; the desktop app does not, and a second implementation of "what
// changed in this file" is the one bug this design rules out rather than tests
// for.
//
// Everything reaches the disk through a platform (src/platform.js).
import { DocStore } from './store.js';
import { hashContent } from './hash.js';
import { createGit } from './git.js';
import { systemFonts } from './fonts.js';
import { homeRelative } from './platform.js';
import { createPlantumlRenderer } from './plantuml.js';

// How far back to read a file's committed history when it is first opened.
// Deep enough to cover the life of a document anyone is still editing, and
// shallow enough that a repo with thousands of commits does not stall.
const GIT_IMPORT_MAX = 50;

// After a change lands, how long to wait before reading the file. An editor
// saving is several filesystem events, and this is what makes them one read.
const SETTLE_MS = 80;

// A safety net for network and otherwise odd filesystems, where a watch can
// simply not fire. Cheap: it reads the file and compares, nothing more.
const POLL_MS = 1500;

// How many versions' worth of check-offs travel with a document. Each is a
// whole snapshot for the page to split, and a reader who never marks a version
// read goes on checking things off across version after version; the newest
// are the ones an edit can have just lapsed. Older ones still hide their own
// marks — only the "what moved since you checked it" falls back to "added".
const MAX_ACK_VERSIONS = 20;

export async function createReader({ platform, plantumlJar } = {}) {
  const plantuml = await createPlantumlRenderer({ jar: plantumlJar }, platform);
  const git = createGit(platform);
  const home = await platform.homeDir();

  // --- open documents ------------------------------------------------------
  // One entry per distinct file being read, keyed by a hash of its path, so
  // several windows can share one reader — and two windows on the same file
  // share one watcher and one store. Entries are reference counted: the last
  // window to let go of a document is the one that stops watching it.

  const docs = new Map();
  const firstDoc = () => docs.values().next().value ?? null;

  /**
   * The document a caller means. A plain browser tab names no document and
   * gets whichever one is open; a window that names a closed one gets nothing,
   * rather than being quietly shown somebody else's file.
   */
  const lookup = (id) => (id ? docs.get(id) ?? null : firstDoc());

  // --- listeners -----------------------------------------------------------
  // Who to tell when a document moves. A listener names the document it cares
  // about, and is moved across by setFile rather than being dropped, so a view
  // that follows "whatever is open" goes on following it.

  const listeners = new Set(); // { id, fn }

  const emit = (id, event) => {
    for (const l of listeners) if (l.id === id) l.fn(event);
  };

  /** Hear about one document. Returns the handle, which is how you stop. */
  function subscribe(id, fn) {
    const l = { id, fn };
    listeners.add(l);
    return () => listeners.delete(l);
  }

  // --- watching ------------------------------------------------------------

  async function watch(d) {
    const check = (retry = 3) => {
      clearTimeout(d.timer);
      d.timer = setTimeout(async () => {
        if (docs.get(d.id) !== d) return; // released mid-flight
        const content = await platform.readText(d.abs);
        if (content == null) {
          // Mid atomic save (write temp + rename) the path briefly disappears.
          if (retry > 0) check(retry - 1);
          return;
        }
        if (content === d.current) return;
        d.current = content;
        await d.store.record(d.current);
        // Recorded before it is announced: a page that hears about a change
        // asks for the document straight away, and the new version has to be
        // part of the answer.
        if (docs.get(d.id) !== d) return;
        emit(d.id, { type: 'change', hash: hashContent(d.current) });
        // A file that changed under us may have been pulled, checked out or
        // committed — and one first read outside a repo may since have been
        // added to one.
        d.git ??= await git.info(d.abs);
        importGitHistory(d);
      }, SETTLE_MS);
    };

    d.unwatch = await platform.watch(d.abs, check);
    d.poll = setInterval(check, POLL_MS);
    // The file can have changed while the watcher was being set up.
    check();
  }

  // --- opening and closing -------------------------------------------------

  // Opens in flight, id -> Promise. Opening a document takes several awaits,
  // so two windows asking for one file at the same moment would otherwise each
  // build a document and each start a watcher, and the second would evict the
  // first.
  const opening = new Map();

  /** Start reading `next` (or join a document already open on it). Returns its id. */
  async function retain(next) {
    const abs = platform.resolve(next);
    const id = hashContent(abs).slice(0, 12);
    const open = docs.get(id);
    if (open) {
      open.refs++;
      return id;
    }
    if (opening.has(id)) {
      // Wait for whoever got here first, then decide again from what is
      // actually open: their open may have failed, or been let go since.
      await opening.get(id).catch(() => {});
      return retain(next);
    }
    const p = open_(abs, id);
    opening.set(id, p);
    try {
      return await p;
    } finally {
      opening.delete(id);
    }
  }

  async function open_(abs, id) {
    // Read first: a path that cannot be read must fail before anything is
    // registered, since a caller replacing one document with another balances
    // the old reference only once the new one is held.
    const content = await platform.readText(abs);
    if (content == null) throw new Error(`cannot read ${abs}`);

    const d = {
      id,
      abs,
      refs: 1,
      store: await DocStore.open(abs, platform),
      git: await git.info(abs),
      current: content,
      timer: null,
      unwatch: null,
      poll: null,
    };
    await d.store.record(d.current);
    docs.set(id, d);
    await watch(d);
    // Not awaited: the file opens now, and its committed history arrives in
    // the sidebar a moment later.
    importGitHistory(d);
    return id;
  }

  /** Let go of a document; the last holder stops the watcher. */
  function release(id) {
    const d = docs.get(id);
    if (!d || --d.refs > 0) return;
    d.unwatch?.();
    clearInterval(d.poll);
    clearTimeout(d.timer);
    docs.delete(id);
  }

  /**
   * Point an existing view at a different file. Listeners still on the old id
   * are moved across, so a plain browser tab — which never names a document —
   * follows along without reconnecting. The desktop shell opens a tab instead,
   * so this is for an embedder that has only the one view.
   */
  async function setFile(next, oldId = firstDoc()?.id) {
    const id = await retain(next); // throws on a bad path before the old one is dropped
    // Unconditional: re-opening the file already in this view lands on the
    // same id, and the retain above still has to be balanced.
    if (oldId) release(oldId);
    for (const l of listeners) if (l.id === oldId) l.id = id;
    emit(id, { type: 'file', path: docs.get(id).abs });
    return { id, abs: docs.get(id).abs };
  }

  /**
   * Bring a document's history up to date with git. A file that has been in a
   * repo for a year already has a history — it would be strange for the reader
   * to start from "no earlier versions" when they are all right there — and it
   * goes on being committed to while nobody is reading it, so this is a
   * catch-up rather than a one-off seeding.
   *
   * Only commits not already folded in are read, so the usual case costs a
   * single `git log` and nothing else. Run on open and on every change to the
   * file, which is when a pull or a checkout would have brought new ones in.
   */
  async function importGitHistory(d) {
    if (!d.git || d.gitBusy) return;
    d.gitBusy = true;
    try {
      const commits = await git.log(d.git, GIT_IMPORT_MAX);
      const seen = d.store.gitSeen;
      const fresh = commits.filter((c) => !seen.has(c.sha)).reverse(); // oldest first
      if (!fresh.length) return;

      const versions = [];
      for (const c of fresh) {
        const text = await git.showAt(d.git, c.sha, c.relPath);
        if (text == null) continue;
        versions.push({ text, ts: c.ts, git: { sha: c.sha, subject: c.subject } });
      }
      // Reading a repo takes long enough that the tab can be gone by now, and
      // writing history for a document nobody holds would resurrect its store.
      if (docs.get(d.id) !== d) return;

      if (await d.store.importGit(versions)) emit(d.id, { type: 'history' });
    } finally {
      d.gitBusy = false;
    }
  }

  // --- baselines -----------------------------------------------------------

  async function resolveBaseline(doc, id) {
    const { store } = doc;
    if (id === 'none') return null;
    if (id === 'git:HEAD') return git.show(doc.git, 'HEAD');
    if (id?.startsWith('snap:')) return store.read(id.slice(5));
    return store.read(store.baseline); // 'read' (default)
  }

  /** Whether a baseline can still be honoured — the store forgets things. */
  function validBaseline(doc, wanted) {
    let id = wanted;
    // `last:<fallback>` is a document being opened rather than a baseline being
    // chosen: compare against whatever this one was on last time, and fall back
    // to `<fallback>` only if it has never been chosen. The fallback travels in
    // the token because it comes from a setting the page holds and this side
    // does not — resolving the pair here is what lets the first paint be right
    // instead of corrected a moment later.
    if (id?.startsWith('last:')) {
      const fallback = id.slice(5);
      id = doc.store.compare || fallback;
      // Only a concrete selector is ever stored, so a `last:` arriving from the
      // store is an index edited by hand. One strip, not a recursion that would
      // never bottom out.
      if (id.startsWith('last:')) id = 'read';
    }
    if (id === 'git:HEAD' && !doc.git) return 'read';
    if (id?.startsWith('snap:')) {
      const hash = id.slice(5);
      const kept = doc.store.data.history.some((h) => h.hash === hash);
      return kept ? id : 'read';
    }
    return id || 'read';
  }

  /**
   * Every version this document has, newest first, with enough about each one
   * to tell them apart in a list: when it was, how big, what it came from, and
   * whether it is the version on disk or the one counted as read.
   *
   * This is the whole of what a reader can compare against — there is no second,
   * shorter list for a toolbar. A version gets a row, and the two pointers that
   * follow the file rather than naming a version, `current` and `baseline`, are
   * marks on the row they happen to be on.
   */
  function historyPayload(doc) {
    const { store, current } = doc;
    const currentHash = hashContent(current);
    const rows = store.data.history.slice().reverse();
    return rows.map((h, i) => {
      const older = rows[i + 1];
      return {
        hash: h.hash,
        ts: h.ts,
        size: h.size ?? null,
        // Against the version before it, so a row can say how much it moved.
        delta: h.size != null && older?.size != null ? h.size - older.size : null,
        current: h.hash === currentHash,
        baseline: h.hash === store.baseline,
        git: h.git ?? null,
      };
    });
  }

  // --- the document payload ------------------------------------------------

  /**
   * The versions check-offs were made in, newest first, each with the blocks
   * checked in it: `[{ hash, text, blocks }]`. The page splits them to find the
   * text you read, because splitting is markdown-it and that is on its side
   * (see `renderDiff`).
   *
   * Not the current version — a block checked in it is still in the file word
   * for word, so it has not moved since — and nothing when there is no diff to
   * use them in. A version that cannot be read is left out quietly: its
   * check-offs degrade to the plain "added" they would have been anyway.
   */
  async function ackedFrom(doc, base) {
    if (base == null) return [];
    const current = hashContent(doc.current);
    const byVersion = new Map();
    for (const a of doc.store.ackRecords.reverse()) {
      if (!a.at || !a.block || a.at === current) continue;
      if (!byVersion.has(a.at)) {
        if (byVersion.size >= MAX_ACK_VERSIONS) continue;
        byVersion.set(a.at, []);
      }
      byVersion.get(a.at).push(a.block);
    }
    const out = [];
    for (const [hash, blocks] of byVersion) {
      const text = await doc.store.read(hash);
      if (text != null) out.push({ hash, text, blocks });
    }
    return out;
  }

  async function buildDoc(doc, wanted) {
    const { abs, current } = doc;
    const baselineId = validBaseline(doc, wanted);
    const base = await resolveBaseline(doc, baselineId);

    // A write in what otherwise reads as a read, and deliberately here: this is
    // the only place that knows which baseline was actually honoured rather
    // than merely asked for, so remembering it here means marking read, pruning
    // and picking a version out of the list all keep the memory current with no
    // call site left to forget.
    //
    // Two requests are not choices and are not kept. A `last:` one chose
    // nothing — resolving its fallback is the reader filling a blank, and
    // storing that would pin a document to whatever the setting happened to say
    // the first time it was opened. And `'none'` names no version at all; it is
    // the absence of a comparison, which the page keeps as its own switch and
    // the history list has no row to show as chosen.
    if (!wanted?.startsWith('last:') && baselineId !== 'none') {
      await doc.store.setCompare(baselineId);
    }

    // Two versions of the text, and everything only this side can know: where
    // the file is, when it changed, what the store remembers about it.
    //
    // The document itself -- html, rawHtml, stats, changes, toc -- is not here.
    // It is rendered by the page, from `text` and `base`, by the same module
    // whichever front end is asking. Rendering it here as well would mean two
    // implementations of the diff, and the diff is the product: a browser tab
    // and the app disagreeing about what changed is the one bug this design
    // rules out rather than tests for.
    //
    // `base` is null when there is nothing to compare against, which the page
    // needs told apart from an empty baseline -- one renders plainly, the other
    // marks the whole file as added.
    return {
      id: doc.id,
      path: abs,
      name: platform.basename(abs),
      dir: platform.dirname(abs),
      // Several files open at once can share a name and come from anywhere, so
      // the bar shows where this one is as well as what it is called. Both
      // forms, because the bar shows the file as well once it has a title of
      // its own to show instead of the file's name -- and joining a path is the
      // separator's business, which is this side's and not the page's.
      dirLabel: homeRelative(platform.dirname(abs), home),
      pathLabel: homeRelative(abs, home),
      hash: hashContent(current),
      mtime: await platform.modified(abs),
      text: current,
      base,
      acked: doc.store.acked,
      ackedFrom: await ackedFrom(doc, base),
      baseline: baselineId,
      baselineAvailable: base != null,
      history: historyPayload(doc),
      tracked: Boolean(doc.git),
    };
  }

  // --- what a view can ask for --------------------------------------------
  // Each of these takes the id of a document and throws Closed if it has gone,
  // which is a thing that happens: a window can be shut while a request from
  // its page is in flight.

  const need = (id) => {
    const doc = lookup(id);
    if (!doc) throw new Closed();
    return doc;
  };

  return {
    plantuml,
    retain,
    release,
    setFile,
    subscribe,

    /**
     * The document, against `baseline`:
     *
     * - `'read'` — the version marked read (the default sense of a change mark)
     * - `'none'` — nothing; render the file plainly
     * - `'git:HEAD'` — the committed version
     * - `'snap:<hash>'` — one named version out of the history
     * - `'last:<one of the above>'` — whatever this document was last compared
     *   against, and the named one only if it never has been. Asking this way
     *   is how a document is *opened*; the four above are how a baseline is
     *   *chosen*, and choosing one is what the next `last:` will answer with.
     */
    doc: (id, baseline = 'last:read') => buildDoc(need(id), baseline),

    /**
     * Count this version as read: everything in it stops being a change.
     *
     * Not undoable, and does not need to be — the version the mark came off is
     * still in the history, and clicking its row compares against it again.
     *
     * Every check-off goes with it. "All of this is seen" subsumes each "that
     * bit is seen", and a check-off left behind names a version and a block
     * that would go on being matched against edits made long after the read.
     */
    async markRead(id) {
      const doc = need(id);
      await doc.store.record(doc.current);
      await doc.store.setBaseline(hashContent(doc.current));
      await doc.store.clearAcked();
      return buildDoc(doc, 'read');
    },

    /**
     * Check one change off, or bring it back, or bring all of them back.
     *
     * Answers with the list and nothing else. The caller has already hidden
     * the mark — it knows what it clicked — so there is no document to rebuild.
     * Marking a version read says "all of this is seen" and changes what
     * everything is measured from; this says only "that bit is seen", and
     * leaves the rest of what moved still marked.
     *
     * `at` is the version the page was showing when it was clicked, and
     * `block` the change's `block` from that render: what the change was, so an
     * edit to it later is marked against it (see `ackRecords` in the store).
     * Without `at` it is the version on disk, which is the same thing unless
     * the file moved while the click was in flight.
     */
    ack(id, { key, on = true, clear = false, at, block } = {}) {
      const doc = need(id);
      if (clear) return doc.store.clearAcked();
      if (!key) throw new Error('no change named');
      return doc.store.setAcked(key, on, { at: at || hashContent(doc.current), block });
    },

    /**
     * Forget a version and everything older than it. The one thing here that
     * deletes rather than adds, so the caller names the version it means and
     * the store refuses to drop the newest.
     */
    async prune(id, upto, baseline = 'last:read') {
      const doc = need(id);
      const removed = await doc.store.prune(upto);
      // Those objects may be the last references; the store is shared between
      // documents, so only a sweep of every one of them can say.
      if (removed) await DocStore.gc(platform);
      return { ...(await buildDoc(doc, baseline)), removed };
    },

    /** Render one PlantUML fence to inline SVG, or say why not. */
    async plantumlSvg(code) {
      const out = await plantuml.render(code);
      return out?.svg ? { svg: out.svg } : { error: out?.error ?? plantuml.hint };
    },

    /**
     * The typefaces installed here, for the settings sheet. Nothing to do with
     * a document — it lives here because this is the one thing both shells
     * hold, and it is the platform underneath that knows the answer.
     */
    fonts: () => systemFonts(platform),

    /**
     * The id a caller's `id` actually means, or null if there is no such
     * document. Empty means "whichever is open", so this is how a view that
     * named nothing gets something concrete to subscribe to.
     */
    idOf: (id) => lookup(id)?.id ?? null,

    /** Which file a document is, or null once it is closed. */
    pathOf: (id) => docs.get(id)?.abs ?? null,
    get abs() {
      return firstDoc()?.abs ?? null;
    },

    /** Let go of everything. */
    closeAll() {
      for (const id of [...docs.keys()]) {
        docs.get(id).refs = 1;
        release(id);
      }
    },
  };
}

/** Asked about a document that is not open. Worth telling apart: it is not an error in the caller. */
export class Closed extends Error {
  constructor() {
    super('document closed');
    this.name = 'Closed';
  }
}
