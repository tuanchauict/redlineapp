// What the page shows when it has nothing to read. Only a backend that has to be given
// something has one -- the web app's -- so a window shown a document by a shell, or a server told
// one on a command line, never reaches any of this and nothing here has to ask which it is.
// The backend has the doors and ui/Welcome.tsx draws them, with this in between: what the
// welcome says goes from one to the other by `welcomeView`.
//
// Two of the doors open a file, which is what the modules over this one do; they are handed in
// by `bindWelcome`, and are only ever reached from a click, long after the page has started.
import { state, barName, prefsOpen, welcomeView } from '../state.js';
import { $, doc } from '../dom.js';
import { backend } from '../backend.js';
import { notify } from './notice.js';

interface Doors {
  /** Open the file picked or dropped. Whether it is on screen. */
  open(path: string): Promise<boolean>;
  /** The user said yes to a file that had to be asked for again. */
  granted(): Promise<void>;
}

let doors: Doors | null = null;

export function bindWelcome(given: Doors) {
  doors = given;
}

export const welcomeEl = $('welcome');
export const welcome = backend.welcome?.({
  open: (path) => doors.open(path),
  granted: () => doors.granted(),
  show: (view) => (welcomeView.value = view),
  showing: () => !welcomeEl.hidden,
  // What it has to say while it is hidden (a folder, a file that is not markdown, one that would
  // not open) goes where the user is looking instead of onto a screen they have not been taken to.
  notify: (text) => notify(text),
});

/**
 * The file the user went to when it turned out to need asking for again: asked for, it is the
 * thing they wanted, and the document they were reading is not. Live for an importer; set
 * through `setPendingLink`.
 */
export let pendingLink = null;
export function setPendingLink(path) {
  pendingLink = path;
}
// What the welcome is showing now, as `showWelcome` was last told, so that being told the same
// again -- a load, the watch and the backend's listener each report one lapsed grant -- does not
// wipe a message the user is looking at.
let welcomeSeen = null;
/**
 * The file it is offering to ask for again, if it is. A load that is refused after the
 * backend's listener has already said which file says only *that* it was, and must not
 * replace the name with a guess.
 */
export let welcomeAsks = null;

export function showWelcome({ reopen = null } = {}) {
  if (!welcome) return;
  // A document that is still held is one the user can go back to; one that is gone is not.
  const back = Boolean(state.data);
  const seen = `${reopen}|${back}`;
  document.documentElement.classList.add('welcoming');
  welcomeEl.hidden = false;
  doc.hidden = true;
  if (seen === welcomeSeen) return;
  welcomeSeen = seen;
  welcomeAsks = reopen;
  welcome.sync({ reopen, back });
  if (!back) {
    document.title = 'Redline';
    barName.value = { name: 'Redline', dir: '', path: '' };
  }
}

export function hideWelcome() {
  if (!welcome) return;
  welcomeSeen = null;
  welcomeAsks = null;
  document.documentElement.classList.remove('welcoming');
  welcomeEl.hidden = true;
  doc.hidden = false;
}

/** Back to the document the welcome was put up over. Whether there was one to go back to. */
export function backToDocument() {
  if (welcomeEl.hidden || !state.data) return false;
  pendingLink = null;
  hideWelcome();
  return true;
}

// A step away from the document, and Escape is the step back. Not while Settings is up: the
// Escape is the dialog's, and closes it alone.
if (welcome) {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && prefsOpen.value === null) backToDocument();
  });
}

// The backend says which file; the load that hit the lapse says only that it did.
backend.onNeedsPermission?.(({ name }) => showWelcome({ reopen: name }));
