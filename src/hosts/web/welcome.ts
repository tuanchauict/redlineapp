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
// The page owns *whether* it is showing -- it hides the document and un-hides this -- and this
// owns what is inside. DOM is built with `createElement` and `textContent`, never `innerHTML`:
// a file name is the user's, and is not to be trusted with markup.
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

/** Where the Mac app is to be had: the landing page's download, which follows each release. */
export const MAC_APP_URL = 'https://redline.iamtuna.org/#get';

/**
 * A DOM element with its properties, attributes and children, without a framework. `props` is a
 * bag of `any` because of the loop, not the call sites: it sets every key but `attrs` and `on`
 * onto the element by name, which no type can follow. The call sites could be typed later, at the
 * cost of a few casts in the loop, and the casts erase.
 */
function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: Record<string, any> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    // `v` is `any`, and `Object.entries` of an `any` gives `unknown` values, which `setAttribute`
    // and `addEventListener` will not take: hence the type arguments. `v` is only assigned in the
    // last branch, so the element is cast to a record of `unknown`.
    if (k === 'attrs') for (const [a, val] of Object.entries<string>(v)) el.setAttribute(a, val);
    else if (k === 'on')
      for (const [ev, fn] of Object.entries<EventListener>(v)) el.addEventListener(ev, fn);
    else (el as Record<string, unknown>)[k] = v;
  }
  el.append(...kids);
  return el;
}

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
  /** Leave the welcome for the document that is still on screen. */
  back: () => void;
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
  sync(state?: { reopen?: string | null; back?: boolean }): void;
  pickFile: () => void;
}

/** Fill `el` -- the `#welcome` section, emptied -- and listen for drops. */
export function mountWelcome(
  el: HTMLElement,
  { backend, open, granted, back, notify = null, win = globalThis, doc }: WelcomeDeps,
): Welcome {
  doc ??= el.ownerDocument ?? win.document;
  const canFile = typeof win.showOpenFilePicker === 'function';

  let busy = false;
  // `navigator.storage.persist()` is a request the browser answers from how much it has been
  // used, and Firefox asks the user, which it may do only for a click. A pick is the first click
  // that matters and the page is the place for it. Once: the answer does not change by asking.
  let persisted = false;

  const status = h(doc, 'p', {
    className: 'welcome-status',
    hidden: true,
    attrs: { role: 'status' },
  });
  const say = (text: string) => {
    // The status line is inside the section, so while that is hidden nobody can read it: a drop
    // onto a page with a document open that cannot be opened would otherwise say nothing at all.
    if (text && el.hidden && notify) return notify(text);
    status.textContent = text ?? '';
    status.hidden = !text;
  };

  /**
   * One thing at a time, and a picker that was cancelled is not a failure. Runs `fn` before it
   * awaits anything, so a picker is still called inside the click that asked for it.
   */
  async function run(fn: () => void | Promise<void>) {
    if (busy) return;
    busy = true;
    el.setAttribute('aria-busy', 'true');
    try {
      await fn();
    } catch (err) {
      if (err?.name !== 'AbortError') say(`Could not open that: ${err?.message ?? err}`);
    } finally {
      busy = false;
      el.removeAttribute('aria-busy');
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

  // --- the buttons ---------------------------------------------------------------------

  // Where a browser has no picker, an `<input type="file">` is the same button; what it hands
  // back is a copy, not a handle.
  const input = h(doc, 'input', {
    type: 'file',
    hidden: true,
    accept: '.md,.markdown,.mdown,.mkd,.mdx,.txt',
    on: {
      change: () => {
        const file = input.files?.[0];
        input.value = '';
        if (file) run(() => openCopy(file));
      },
    },
  });
  // Called inside a click or a key, as a picker has to be: `run` calls it before it awaits.
  const pickFile = () =>
    canFile
      ? run(async () => {
          const [handle] = await win.showOpenFilePicker({
            types: MARKDOWN_TYPES,
            excludeAcceptAllOption: true,
          });
          await openHandle(handle);
        })
      : input.click();
  const fileBtn = h(doc, 'button', {
    type: 'button',
    className: 'welcome-primary',
    textContent: 'Open file…',
    on: { click: pickFile },
  });

  // --- a grant that lapsed -----------------------------------------------------------------

  const reopenText = h(doc, 'p', { className: 'welcome-reopen-text' });
  let reopenName: string | null = null;
  const reopenBtn = h(doc, 'button', {
    type: 'button',
    className: 'welcome-primary',
    on: {
      click: () =>
        // Nothing awaited before `reopen`: `requestPermission` is refused without a gesture.
        run(async () => {
          say('');
          if (!(await backend.reopen())) return say(`Redline was not given ${reopenName}.`);
          await granted();
          afterOpen();
        }),
    },
  });
  const reopenBox = h(
    doc,
    'div',
    { className: 'welcome-reopen', hidden: true },
    reopenText,
    reopenBtn,
  );

  const backBtn = h(doc, 'button', {
    type: 'button',
    className: 'welcome-secondary',
    textContent: 'Back to the document',
    hidden: true,
    on: { click: () => back() },
  });

  // --- what it says ----------------------------------------------------------------------

  // A browser that can keep a file is told nothing more about it here: what it cannot do is the
  // web app's, and said once, below. One that can only take a copy is told what a copy is.
  const copyHint = canFile
    ? null
    : h(doc, 'p', {
        className: 'welcome-hint',
        textContent:
          'This browser cannot keep a link to files on your disk, so Redline reads a copy of ' +
          'each file you give it, and will not follow later edits. A file with the same name ' +
          'as one you gave before continues its history.',
      });
  // Said before anyone looks for it: the things a person coming from the Mac app reaches for
  // first, and where to get them. In a new tab, so that the way out is not a way off the page.
  const limits = h(
    doc,
    'p',
    { className: 'welcome-hint welcome-limits' },
    'In a browser, Redline reads one file at a time: its links to other files do not open, ' +
      'and there is no git or PlantUML. ',
    h(doc, 'a', {
      href: MAC_APP_URL,
      target: '_blank',
      rel: 'noopener',
      textContent: 'Get the Mac app',
    }),
    ' for all of it.',
  );

  el.replaceChildren(
    h(doc, 'h1', { className: 'welcome-title', textContent: 'Redline' }),
    h(doc, 'p', {
      className: 'welcome-lede',
      textContent: 'Read a markdown file, and see what changed in it since you last did.',
    }),
    reopenBox,
    h(doc, 'div', { className: 'welcome-actions' }, fileBtn, backBtn),
    input,
    h(doc, 'p', { className: 'welcome-hint', textContent: 'Or drop a markdown file.' }),
    ...(copyHint ? [copyHint] : []),
    status,
    limits,
  );

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
    /**
     * What the page knows that the welcome does not: whether to ask again, or go back. The page
     * calls it only when that changed -- a load, a watch and a listener can all report one lapsed
     * grant, and a repeat must not wipe the message the click on its button earned.
     */
    sync({ reopen = null, back: canGoBack = false } = {}) {
      reopenName = reopen;
      reopenBox.hidden = !reopen;
      if (reopen) {
        reopenText.textContent = `Redline needs your permission to read ${reopen} again.`;
        reopenBtn.textContent = `Reopen ${reopen}`;
      }
      backBtn.hidden = !canGoBack;
      // A message about the last attempt is not about this one.
      say('');
    },

    /**
     * The browser's file picker, straight from a click or ⌘O on a document, and not the welcome:
     * a document open is one the user is reading, and what they asked for is another file.
     * What it has to say goes to `notify` while the welcome is hidden, as a drop's does.
     */
    pickFile,
  };
}
