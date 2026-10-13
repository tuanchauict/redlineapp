// The welcome: what the web app shows when there is nothing to read, and the ways to give it
// something.
//
// Drawn from `welcomeView`, which is what src/hosts/web/welcome.ts -- the doors: the picker, the
// drop, the copy, the grant asked for again -- last said. That half is the backend's and is never
// in any other host, so this is only ever mounted where `backend.welcome` is. main.ts owns
// whether it is showing: it un-hides `#welcome` and hides the document.
//
// A file name is the user's and goes in as text, never as markup, which JSX does by itself.
import { createRef, render } from 'preact';
import { effect } from '@preact/signals';
import { welcomeView } from '../state.js';
import type { Welcome as Doors } from '../../../src/hosts/web/welcome.js';

/** Where the Mac app is to be had: the landing page's download, which follows each release. */
export const MAC_APP_URL = 'https://redline.iamtuna.org/#get';

/** What the picker and the input take: markdown and text, as `MD_LINK` reads a name. */
const ACCEPT = '.md,.markdown,.mdown,.mkd,.mdx,.txt';

interface Props {
  doors: Doors;
  pickFile: () => void;
  back: () => void;
  input: ReturnType<typeof createRef<HTMLInputElement>>;
}

function Welcome({ doors, pickFile, back, input }: Props) {
  const v = welcomeView.value;
  if (!v) return null;
  return (
    <>
      <h1 class="welcome-title">
        Redline <span class="beta">Beta</span>
      </h1>
      <p class="welcome-lede">
        Read a markdown file, and see what changed in it since you last did.
      </p>
      {/* A grant that lapsed. Asked for from the click on its button and nothing else: a
          `requestPermission` with no gesture behind it is refused. */}
      <div class="welcome-reopen" hidden={!v.reopen}>
        <p class="welcome-reopen-text">
          {v.reopen && `Redline needs your permission to read ${v.reopen} again.`}
        </p>
        <button type="button" class="welcome-primary" onClick={() => doors.reopen()}>
          {v.reopen && `Reopen ${v.reopen}`}
        </button>
      </div>
      <div class="welcome-actions">
        <button type="button" class="welcome-primary" onClick={pickFile}>
          Open file…
        </button>
        <button type="button" class="welcome-secondary" hidden={!v.back} onClick={back}>
          Back to the document
        </button>
      </div>
      {/* Where a browser has no picker, this is the same button; what it hands back is a copy,
          not a handle. Emptied as it is read, so the same file can be chosen again. */}
      {!v.canFile && (
        <input
          ref={input}
          type="file"
          hidden
          accept={ACCEPT}
          onChange={(e) => {
            const field = e.target as HTMLInputElement;
            const file = field.files?.[0];
            field.value = '';
            if (file) doors.openCopy(file);
          }}
        />
      )}
      <p class="welcome-hint">Or drop a markdown file.</p>
      {/* A browser that can keep a file is told nothing more about it here: what it cannot do is
          the web app's, and said once, below. One that can only take a copy is told what a copy
          is. */}
      {!v.canFile && (
        <p class="welcome-hint">
          This browser cannot keep a link to files on your disk, so Redline reads a copy of each
          file you give it, and will not follow later edits. A file with the same name as one you
          gave before continues its history.
        </p>
      )}
      <p class="welcome-status" role="status" hidden={!v.status}>
        {v.status}
      </p>
      {/* Said before anyone looks for it: the things a person coming from the Mac app reaches
          for first, and where to get them. In a new tab, so that the way out is not a way off
          the page. */}
      <p class="welcome-hint welcome-limits">
        In a browser, Redline reads one file at a time: its links to other files do not open, and
        there is no git or PlantUML.{' '}
        <a href={MAC_APP_URL} target="_blank" rel="noopener">
          Get the Mac app
        </a>{' '}
        for all of it.
      </p>
    </>
  );
}

/**
 * Draw the welcome into `root`, the `#welcome` section, which it owns the children of from here
 * on. Answers the way to a file -- the picker where there is one, the input where there is not --
 * for the page's own Open and ⌘O, which reach it with a document on screen and the welcome
 * hidden.
 */
export function mountWelcome(root: HTMLElement, doors: Doors, back: () => void) {
  const input = createRef<HTMLInputElement>();
  // Inside the click or the key that asked, as a picker has to be: nothing is awaited first.
  const pickFile = () => (doors.canFile ? doors.pickFile() : input.current?.click());
  render(<Welcome doors={doors} pickFile={pickFile} back={back} input={input} />, root);
  // The section is the root, which the component does not draw, so its one attribute is kept here.
  effect(() => {
    if (welcomeView.value?.busy) root.setAttribute('aria-busy', 'true');
    else root.removeAttribute('aria-busy');
  });
  return pickFile;
}
