// The files a browser tab has open, for the left column. The desktop app's are its tabs, which
// the shell keeps for each window and pushes to the page; a browser tab has no shell, so the web
// app keeps a list of its own here, and the page draws it with the same rows.
//
// Kept twice. In sessionStorage, so that a reload keeps the list and two tabs on the app each
// have their own; and the last list any tab wrote in localStorage, for a tab that comes to the
// app's bare address with nothing of its own -- as the worker gives that tab the document a tab
// last showed (`last`, in handles.ts). Neither is a reason to fail: a browser that refuses
// storage gets a list that lasts as long as the page.

export const OPEN_KEY = 'redline:open';

/** A file in the list. `path` is what `open` takes and `label` is how it is shown. */
export interface OpenFile {
  id: string;
  path: string;
  name: string;
  dir: string;
  label: string;
}

const isEntry = (t: any): t is OpenFile =>
  typeof t?.id === 'string' && typeof t.path === 'string' && typeof t.name === 'string';

function read(store: Storage | null | undefined): OpenFile[] | null {
  try {
    const list = JSON.parse(store?.getItem(OPEN_KEY) ?? 'null');
    return Array.isArray(list) ? list.filter(isEntry) : null;
  } catch {
    return null;
  }
}

/** One of the window's storages, or null: asking for one can throw where cookies are blocked. */
export function storageOf(win: any, name: 'sessionStorage' | 'localStorage'): Storage | null {
  try {
    return win?.[name] ?? null;
  } catch {
    return null;
  }
}

export interface OpenFilesOptions {
  /** This tab's own. Default: sessionStorage. */
  tab?: Storage | null;
  /** Every tab's. Default: localStorage. */
  shared?: Storage | null;
}

export function createOpenFiles({
  tab = storageOf(globalThis, 'sessionStorage'),
  shared = storageOf(globalThis, 'localStorage'),
}: OpenFilesOptions = {}) {
  let list = read(tab) ?? read(shared);
  // Whether there has been a list at all. A first visit has closed nothing; a tab whose list is
  // empty because every file in it was closed has, and is not to be handed one back.
  let kept = list !== null;
  list ??= [];

  function save() {
    kept = true;
    const text = JSON.stringify(list);
    for (const store of [tab, shared]) {
      try {
        store?.setItem(OPEN_KEY, text);
      } catch {
        // Full, or refused. The list on the page is still right.
      }
    }
  }

  return {
    /**
     * The files, in the order they were opened: `{ id, path, name, dir, label }`, `path` being
     * what `open` takes and `label` how it is shown.
     */
    list: () => list.map((t) => ({ ...t })),

    /** Whether every file this tab had was closed, so that there is nothing to come back to. */
    closedAll: () => kept && list.length === 0,

    /**
     * The document on screen: added at the end if it is not open already, as a file opened in
     * the desktop app joins the window as a tab, and relabelled if it is -- a folder granted
     * again can come back under another name. Answers whether the list changed.
     */
    note({ id, path, name, dir = '', label = path }) {
      const t = { id, path, name, dir, label };
      const at = list.findIndex((o) => o.id === id);
      const was = list[at];
      if (was && Object.keys(t).every((k) => was[k] === t[k])) return false;
      if (was) list[at] = t;
      else list.push(t);
      save();
      return true;
    },

    /**
     * Take a file off the list. Answers the one that stands in its place -- the next, or the one
     * before when it was the last, as closing a tab goes to its neighbour -- or null when none
     * is left. Which is only the page's to act on if the file closed was the one on screen.
     */
    close(id) {
      const at = list.findIndex((t) => t.id === id);
      if (at < 0) return null;
      list.splice(at, 1);
      save();
      const next = list[at] ?? list[at - 1];
      return next ? { ...next } : null;
    },
  };
}
