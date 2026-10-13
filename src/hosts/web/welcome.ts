// The web app's empty state: what the page shows when there is nothing to read, and the ways to
// give it something.
//
// A desktop reader is handed its file on a command line and a server is told one; a web page is
// handed nothing, and everything it may read the user has to put in front of it. So this is not
// decoration. It is the only door, and it has to cover the three a browser has:
//
//   - a file, from `showOpenFilePicker`. Watched for edits; its links to other files cannot be
//     followed, because the grant is for that one file and not for anything beside it
//   - a drop, whose `DataTransferItem` can give a handle, and so is the same as a pick
//   - a drop or an `<input type="file">` that gives only a `File`: a copy. Where there is no File
//     System Access at all, this is all there is -- no watching, no links, and a name that is the
//     whole of its identity, so that two files of the same name are one history
//
// Files, and not folders. The web app is a reader for the file in front of you; a set of notes
// with the links between them is the Mac app's, and the welcome says so, with the way to it,
// rather than leave a user to find out what a browser cannot do one refusal at a time. So
// nothing offers to pick a folder, and one dropped is refused.
//
// It is also where a lapsed permission is asked for again, because the button for it has to be
// somewhere a click can reach and the welcome is where the page already is when nothing opened.
//
// The page owns *whether* it is showing, and what it looks like: public/app/ui/Welcome.tsx draws
// it, with the `<input type="file">` that stands in for a picker. This owns the doors -- the
// picker, the drop, the copy and the grant asked for again -- and what the welcome has to say
// about them, which it hands the page as a `WelcomeView` each time that changes. Not a signal:
// this is the backend's bundle and the page is another, and a signal from one copy of the
// library is not tracked by the other's components.
import { MD_LINK } from '../../core/links.js';
import { webPath } from './handles.js';

// Not in lib.dom yet: the File System Access API's handle for a dropped item (Chromium only, which
// is why it is tried and the `File` is the fallback).
type DroppableItem = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
};

// Not in lib.dom either: the File System Access API's picker, which only a Chromium window has,
// and which `canFile` asks for by looking.
type PickerWindow = typeof globalThis & {
  showOpenFilePicker?: (options: {
    types?: { description?: string; accept: Record<string, string[]> }[];
    excludeAcceptAllOption?: boolean;
  }) => Promise<FileSystemFileHandle[]>;
};

const MARKDOWN_TYPES = [
  {
    description: 'Markdown and text',
    accept: {
      'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.mdx'],
      'text/plain': ['.txt'],
    },
  },
];
const NOT_MARKDOWN =
  'Redline opens markdown and text files: .md, .markdown, .mdown, .mkd, .mdx, .txt';
const NOT_A_FOLDER =
  'The web app opens files, not folders: drop a markdown file, or open the folder in the Mac app.';

/** What the welcome says, for the page to draw. */
export interface WelcomeView {
  /**
   * Whether this browser has a file picker, and so keeps a link to a file rather than a copy.
   * Without one the page's `<input type="file">` is the button, and the welcome says what a copy
   * is.
   */
  canFile: boolean;
  /** A pick, a drop or a grant is under way, and another is not taken until it is done. */
  busy: boolean;
  /** About the last attempt, or '' for nothing to say. */
  status: string;
  /** The file to offer to ask for again, or null. */
  reopen: string | null;
  /** Whether there is a document to go back to. */
  back: boolean;
}

export interface WelcomeDeps {
  backend: {
    addRoot(handle: FileSystemHandle): Promise<{ rootId: string }>;
    addDrop(file: File): Promise<string>;
    reopen(): Promise<boolean>;
  };
  /** Show that path; whether it could. */
  open: (path: string) => Promise<boolean>;
  /** `reopen` was granted: load again, or open the file that was refused. */
  granted: () => Promise<void>;
  /** What the welcome says has changed. Called once at the start, with what it says first. */
  show: (view: WelcomeView) => void;
  /** Whether the welcome is on screen, which is the page's to know. */
  showing: () => boolean;
  /**
   * Say something where the user is looking. What the welcome has to say while it is hidden -- a
   * drop refused, onto a document -- goes here, since revealing it for that would take the user
   * off the document for a file they were told they cannot open.
   */
  notify?: ((text: string) => void) | null;
  /** Pickers, `navigator`, and what fires `dragover`. */
  win?: PickerWindow;
  doc?: Document;
}

export interface Welcome {
  /** As in `WelcomeView`: whether `pickFile` has a picker to call. */
  canFile: boolean;
  sync(state?: { reopen?: string | null; back?: boolean }): void;
  /**
   * The browser's file picker. Only where there is one (`canFile`); elsewhere the page's input is
   * the picker and hands what it was given to `openCopy`.
   */
  pickFile(): Promise<void>;
  /** A file the page's `<input type="file">` was given: a copy. */
  openCopy(file: File): Promise<void>;
  /** Ask for the lapsed file again. From the click on the button, and nothing awaited before. */
  reopen(): Promise<void>;
}

/** Listen for drops, and answer for the ways in the page draws. */
export function mountWelcome({
  backend,
  open,
  granted,
  show,
  showing,
  notify = null,
  win = globalThis,
  doc,
}: WelcomeDeps): Welcome {
  doc ??= win.document;
  const canFile = typeof win.showOpenFilePicker === 'function';

  // What it says, and the one way it changes: a new object handed to `show` each time, so the
  // page never holds the one this goes on to replace.
  let view: WelcomeView = { canFile, busy: false, status: '', reopen: null, back: false };
  const set = (patch: Partial<WelcomeView>) => {
    view = { ...view, ...patch };
    show(view);
  };
  show(view);

  // `navigator.storage.persist()` is a request the browser answers from how much it has been
  // used, and Firefox asks the user, which it may do only for a click. A pick is the first click
  // that matters and the page is the place for it. Once: the answer does not change by asking.
  let persisted = false;

  const say = (text: string) => {
    // While the welcome is hidden nobody can read what it says: a drop onto a page with a
    // document open that cannot be opened would otherwise say nothing at all.
    if (text && !showing() && notify) return notify(text);
    set({ status: text ?? '' });
  };

  /**
   * One thing at a time, and a picker that was cancelled is not a failure. Runs `fn` before it
   * awaits anything, so a picker is still called inside the click that asked for it.
   */
  async function run(fn: () => void | Promise<void>) {
    if (view.busy) return;
    set({ busy: true });
    try {
      await fn();
    } catch (err) {
      if (err?.name !== 'AbortError') say(`Could not open that: ${err?.message ?? err}`);
    } finally {
      set({ busy: false });
    }
  }

  function afterOpen() {
    if (persisted) return;
    persisted = true;
    try {
      Promise.resolve(win.navigator?.storage?.persist?.()).catch(() => {});
    } catch {
      // A browser without it keeps what it keeps.
    }
  }

  async function openPath(path: string) {
    if (await open(path)) afterOpen();
    else say('Could not open that file.');
  }

  async function openHandle(handle: FileSystemHandle) {
    if (handle.kind === 'directory') return say(NOT_A_FOLDER);
    if (!MD_LINK.test(handle.name)) return say(NOT_MARKDOWN);
    const { rootId } = await backend.addRoot(handle);
    await openPath(webPath(rootId, handle.name));
  }

  async function openCopy(file: File) {
    if (!MD_LINK.test(file.name)) return say(NOT_MARKDOWN);
    await openPath(await backend.addDrop(file));
  }

  // --- drops ------------------------------------------------------------------------------

  // On the window and not on the welcome: a file dropped on a page that is not listening is
  // *opened by the browser*, in place of this page, and that is as true with a document open as
  // without one.
  const root = doc.documentElement;
  let depth = 0;
  const carriesFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  const over = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    root.classList.add('dropping');
  };
  win.addEventListener?.('dragenter', (e) => {
    if (carriesFiles(e)) depth++;
    over(e);
  });
  win.addEventListener?.('dragover', over);
  win.addEventListener?.('dragleave', (e) => {
    if (carriesFiles(e) && --depth <= 0) {
      depth = 0;
      root.classList.remove('dropping');
    }
  });
  win.addEventListener?.('drop', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    depth = 0;
    root.classList.remove('dropping');
    // All read here, before anything is awaited: a `DataTransferItem` is empty the moment the
    // handler returns. The handle is the better answer and the `File` is the fallback for a
    // source that has none. A browser with no handles hands a folder over as a `File` too, named
    // for the folder, and only the entry says what it is.
    const item = [...(e.dataTransfer.items ?? [])].find(
      (i): i is DroppableItem => i.kind === 'file',
    );
    const handle = Promise.resolve(item?.getAsFileSystemHandle?.() ?? null).catch((): null => null);
    const folder = item?.webkitGetAsEntry?.()?.isDirectory === true;
    const file = item?.getAsFile?.() ?? e.dataTransfer.files?.[0] ?? null;
    run(async () => {
      const got = await handle;
      if (got) return openHandle(got);
      if (folder) return say(NOT_A_FOLDER);
      if (file) return openCopy(file);
    });
  });

  return {
    canFile,

    /**
     * What the page knows that the welcome does not: whether to ask again, or go back. The page
     * calls it only when that changed -- a load, a watch and a listener can all report one lapsed
     * grant, and a repeat must not wipe the message the click on its button earned.
     */
    sync({ reopen = null, back = false } = {}) {
      // A message about the last attempt is not about this one.
      set({ reopen, back, status: '' });
    },

    /**
     * Called inside a click or a key, as a picker has to be: `run` calls it before it awaits.
     * Straight from a click or ⌘O on a document too, and not the welcome: a document open is one
     * the user is reading, and what they asked for is another file. What it has to say goes to
     * `notify` while the welcome is hidden, as a drop's does.
     */
    pickFile: () =>
      run(async () => {
        const [handle] = await win.showOpenFilePicker({
          types: MARKDOWN_TYPES,
          excludeAcceptAllOption: true,
        });
        await openHandle(handle);
      }),

    openCopy: (file) => run(() => openCopy(file)),

    reopen: () =>
      // Nothing awaited before `reopen`: `requestPermission` is refused without a gesture.
      run(async () => {
        const name = view.reopen;
        say('');
        if (!(await backend.reopen())) return say(`Redline was not given ${name}.`);
        await granted();
        afterOpen();
      }),
  };
}
