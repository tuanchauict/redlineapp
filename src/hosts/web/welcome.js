// The web app's empty state: what the page shows when there is nothing to read, and the ways to
// give it something.
//
// A desktop reader is handed its file on a command line and a server is told one; a web page is
// handed nothing, and everything it may read the user has to put in front of it. So this is not
// decoration. It is the only door, and it has to cover four doors a browser has:
//
//   - a folder, from `showDirectoryPicker`. The primary one: a document's links go to its
//     neighbours, and a folder is the only grant that lets them open
//   - a file, from `showOpenFilePicker`. One file; its links cannot be followed, and the page
//     says to open the folder that holds it
//   - a drop, whose `DataTransferItem` can give a handle, and so is the same as a pick
//   - a drop or an `<input type="file">` that gives only a `File`: a copy. Where there is no File
//     System Access at all, this is all there is -- no watching, no links, and a name that is the
//     whole of its identity, so that two files of the same name are one history
//
// It is also where a lapsed permission is asked for again, because the button for it has to be
// somewhere a click can reach and the welcome is where the page already is when nothing opened.
//
// The page owns *whether* it is showing -- it hides the document and un-hides this -- and this
// owns what is inside. DOM is built with `createElement` and `textContent`, never `innerHTML`:
// a file name is the user's, and the folder's contents are not to be trusted with markup.
import { MD_LINK } from '../../core/links.js';
import { webPath } from './handles.js';

/** How many folders below the one picked the list looks into. */
export const MAX_DEPTH = 3;
/** Where the list stops: a folder of notes is a few dozen, and a checkout of a project is not. */
export const MAX_FILES = 500;

const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * The markdown files in a folder, shown the way a link to one would be recognised (`MD_LINK`).
 * Dot-folders and `node_modules` are not entered: they are where a checkout keeps what is not the
 * user's writing, and left in they would fill the cap with other people's READMEs before the
 * user's own were reached.
 *
 * A folder below the top that cannot be read is skipped, not fatal -- one unreadable directory
 * is no reason to show a user nothing. The top one throws, so the welcome can say why.
 *
 * @param {FileSystemDirectoryHandle} dir
 * @returns {Promise<{ files: string[], capped: boolean }>} Paths relative to `dir`, with `/`.
 */
export async function listMarkdown(dir, { depth = MAX_DEPTH, max = MAX_FILES } = {}) {
  const files = [];
  let capped = false;

  async function walk(at, prefix, left) {
    const below = [];
    for await (const [name, entry] of at.entries()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      if (entry.kind === 'directory') below.push([name, entry]);
      else if (MD_LINK.test(name)) {
        if (files.length >= max) {
          capped = true;
          return;
        }
        files.push(prefix + name);
      }
    }
    if (left === 0) return;
    for (const [name, entry] of below.sort((a, b) => byName(a[0], b[0]))) {
      if (capped) return;
      try {
        await walk(entry, `${prefix}${name}/`, left - 1);
      } catch {
        // Unreadable: leave it out.
      }
    }
  }

  await walk(dir, '', depth);
  return { files: files.sort(byName), capped };
}

/** A DOM element with its properties, attributes and children, without a framework. */
function h(doc, tag, props = {}, ...kids) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'attrs') for (const [a, val] of Object.entries(v)) el.setAttribute(a, val);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else el[k] = v;
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

/**
 * Fill `el` and listen for drops.
 *
 * @param {HTMLElement} el  The `#welcome` section. Emptied.
 * @param {object} deps
 * @param {{ addRoot: Function, addDrop: Function, reopen: () => Promise<boolean> }} deps.backend
 * @param {(path: string) => Promise<boolean>} deps.open  Show that path; whether it could.
 * @param {() => Promise<void>} deps.granted  `reopen` was granted: load again, or open the link
 *   that was refused.
 * @param {() => void} deps.back  Leave the welcome for the document that is still on screen.
 * @param {typeof globalThis} [deps.win]  Pickers, `navigator`, and what fires `dragover`.
 * @param {Document} [deps.doc]
 * @returns {{ sync: (state: { reopen?: string|null, back?: boolean }) => void }}
 */
export function mountWelcome(el, { backend, open, granted, back, win = globalThis, doc }) {
  doc ??= el.ownerDocument ?? win.document;
  const canFolder = typeof win.showDirectoryPicker === 'function';
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
  const say = (text) => {
    status.textContent = text ?? '';
    status.hidden = !text;
  };

  /**
   * One thing at a time, and a picker that was cancelled is not a failure. Runs `fn` before it
   * awaits anything, so a picker is still called inside the click that asked for it.
   */
  async function run(fn) {
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

  async function openPath(path) {
    if (await open(path)) afterOpen();
    else say('Could not open that file.');
  }

  async function openHandle(handle, rel = handle.name) {
    if (!MD_LINK.test(rel)) return say(NOT_MARKDOWN);
    const { rootId } = await backend.addRoot(handle);
    await openPath(webPath(rootId, rel));
  }

  async function openCopy(file) {
    if (!MD_LINK.test(file.name)) return say(NOT_MARKDOWN);
    await openPath(await backend.addDrop(file));
  }

  // --- a folder's files ---------------------------------------------------------------

  const listHead = h(doc, 'h2', { className: 'welcome-folder' });
  const listNote = h(doc, 'p', { className: 'welcome-hint', hidden: true });
  const list = h(doc, 'ul', { className: 'welcome-files' });
  const listBox = h(
    doc,
    'section',
    { className: 'welcome-list', hidden: true },
    listHead,
    list,
    listNote,
  );

  async function showFolder(handle) {
    say(`Reading ${handle.name}…`);
    const { files, capped } = await listMarkdown(handle);
    say(files.length ? '' : `${handle.name} has no markdown files, nor do the folders in it.`);
    listHead.textContent = handle.name;
    list.replaceChildren(
      ...files.map((rel) => {
        const cut = rel.lastIndexOf('/') + 1;
        const item = h(
          doc,
          'button',
          { type: 'button', className: 'welcome-file', title: rel },
          h(doc, 'span', { className: 'welcome-file-dir', textContent: rel.slice(0, cut) }),
          h(doc, 'span', { className: 'welcome-file-name', textContent: rel.slice(cut) }),
        );
        item.addEventListener('click', () => run(() => openHandle(handle, rel)));
        return h(doc, 'li', {}, item);
      }),
    );
    listNote.textContent = capped ? `Only the first ${MAX_FILES} are listed.` : '';
    listNote.hidden = !capped;
    listBox.hidden = !files.length;
  }

  /** A handle that came from a pick or a drop, whichever kind it is. */
  const take = (handle) => (handle.kind === 'directory' ? showFolder(handle) : openHandle(handle));

  // --- the buttons ---------------------------------------------------------------------

  const folderBtn = h(doc, 'button', {
    type: 'button',
    className: 'welcome-primary',
    textContent: 'Open folder…',
    hidden: !canFolder,
    on: {
      click: () => run(async () => showFolder(await win.showDirectoryPicker({ mode: 'read' }))),
    },
  });

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
  const fileBtn = h(doc, 'button', {
    type: 'button',
    className: canFolder ? 'welcome-secondary' : 'welcome-primary',
    textContent: 'Open file…',
    on: {
      click: () =>
        canFile
          ? run(async () => {
              const [handle] = await win.showOpenFilePicker({
                types: MARKDOWN_TYPES,
                excludeAcceptAllOption: true,
              });
              await openHandle(handle);
            })
          : input.click(),
    },
  });

  // --- a grant that lapsed -----------------------------------------------------------------

  const reopenText = h(doc, 'p', { className: 'welcome-reopen-text' });
  let reopenName = null;
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

  // Which of the two is true decides what the user is told to expect of a file.
  const hint = canFolder
    ? 'A folder lets the links between its documents open. A single file cannot follow its ' +
      'links: open the folder that holds it for that.'
    : 'This browser cannot keep a link to files on your disk, so Redline reads a copy of each ' +
      'file you give it. It will not follow later edits, and links between documents will not ' +
      'open. A file with the same name as one you gave before continues its history.';

  el.replaceChildren(
    h(doc, 'h1', { className: 'welcome-title', textContent: 'Redline' }),
    h(doc, 'p', {
      className: 'welcome-lede',
      textContent: 'Read a markdown file, and see what changed in it since you last did.',
    }),
    reopenBox,
    h(doc, 'div', { className: 'welcome-actions' }, folderBtn, fileBtn, backBtn),
    input,
    h(doc, 'p', { className: 'welcome-hint', textContent: 'Or drop a markdown file or a folder.' }),
    h(doc, 'p', { className: 'welcome-hint', textContent: hint }),
    status,
    listBox,
  );

  // --- drops ------------------------------------------------------------------------------

  // On the window and not on the welcome: a file dropped on a page that is not listening is
  // *opened by the browser*, in place of this page, and that is as true with a document open as
  // without one.
  const root = doc.documentElement;
  let depth = 0;
  const carriesFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  const over = (e) => {
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
    // Both are read here, before anything is awaited: a `DataTransferItem` is empty the moment
    // the handler returns. The handle is the better answer and the `File` is the fallback for a
    // source that has none.
    const item = [...(e.dataTransfer.items ?? [])].find((i) => i.kind === 'file');
    const handle = Promise.resolve(item?.getAsFileSystemHandle?.() ?? null).catch(() => null);
    const file = item?.getAsFile?.() ?? e.dataTransfer.files?.[0] ?? null;
    run(async () => {
      const got = await handle;
      if (got) return take(got);
      if (file) return openCopy(file);
    });
  });

  return {
    /**
     * What the page knows that the welcome does not: whether to ask again, or go back. The page
     * calls it only when that changed -- a load, a watch and a listener can all report one lapsed
     * folder, and a repeat must not wipe the message the click on its button earned.
     */
    sync({ reopen = null, back: canGoBack = false } = {}) {
      reopenName = reopen;
      reopenBox.hidden = !reopen;
      if (reopen) {
        reopenText.textContent = `Redline needs your permission to read ${reopen} again.`;
        reopenBtn.textContent = `Reopen ${reopen}`;
      }
      backBtn.hidden = !canGoBack;
      // A message about the last attempt is not about this one, and nor is a folder's list.
      say('');
      listBox.hidden = true;
    },
  };
}
