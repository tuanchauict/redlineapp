// What the store and the git reader need from whatever they are running on.
//
// There are two hosts. In the CLI this is node, and the store runs in the
// server process as it always has. In the desktop app there is no node at all:
// the store runs inside the webview, and reaching the disk means asking Tauri.
// Everything below is what the two have to agree on.
//
// Every call is async, because one of the two hosts has no choice about that.
// That is the whole reason the store's methods became async -- not because
// anything here is slow, but because a synchronous read is a thing only a node
// process can offer, and designing to the more capable host would have meant
// writing the store twice.
//
// Paths are strings the host understands and are built with the host's own
// join/dirname/basename, rather than assumed to be `/`-separated. The store
// writes them into its own index and hands them back to the reader, so getting
// this wrong would not fail loudly -- it would quietly file one document under
// two names.
//
/**
 * @typedef {object} Platform
 *
 * @property {(p: string) => Promise<string|null>} readText
 *   File contents as UTF-8, or null if it is not there. Null rather than a
 *   throw: a missing snapshot is an ordinary thing here -- a store can be
 *   pruned or hand-tidied between one read and the next.
 * @property {(p: string, text: string) => Promise<void>} writeText
 *   Replaces the file **whole**: another process reading it at any moment sees the old text or
 *   the new, never half. The store's index is shared between processes (the app and a browser
 *   tab, two editor windows) and a torn one reads as a first run. The usual way is to write a
 *   temporary file beside it and rename it over the top.
 * @property {(p: string) => Promise<void>} mkdirp
 * @property {(p: string) => Promise<string[]>} readDir  File names, not paths.
 * @property {(p: string) => Promise<void>} remove
 * @property {(from: string, to: string) => Promise<boolean>} rename
 *   Whether it worked. Used once, to move a store left under the app's old
 *   name; a move that cannot be made is not worth failing over, so the caller
 *   wants the answer rather than an exception.
 * @property {(p: string) => Promise<boolean>} exists
 * @property {(p: string) => Promise<number|null>} modified
 *   Last-modified time in ms, or null if it is not there.
 * @property {(p: string, onChange: () => void) => Promise<() => void>} watch
 *   Call `onChange` whenever the file at `p` may have changed; returns a
 *   function that stops watching. "May" is deliberate: a host is free to be
 *   noisy, because the reader compares the content before it believes anything
 *   happened. What a host must not do is watch the file itself and nothing
 *   else — an editor saving atomically writes a temp file and renames it over
 *   the top, which a watch on the file misses entirely. Watch the directory.
 *
 * @property {() => Promise<string>} homeDir
 * @property {(name: string) => string|undefined} env
 *   One environment variable as the host sees it, or undefined. The webview has
 *   no environment of its own; it is answered from the process that owns it,
 *   which is the one that would run the programs PATH names anyway.
 * @property {string} os
 *   'darwin' | 'win32' | 'linux'. Only used where the difference is real: a
 *   program on PATH is found by a different rule on Windows.
 *
 * @property {(cmd: string, args: string[], opts?: SpawnOptions) => Promise<SpawnResult>} [spawn]
 *   Run a program to completion. Used for git, for the PlantUML jar and for listing fonts,
 *   all of which are the host's to find: they are not on a path the webview knows.
 *   **Optional.** A host that cannot run a program -- a browser with no server behind it --
 *   leaves `spawn` out entirely. It does not provide a function that throws, because the
 *   reader reads the absence: without it, git, PlantUML and fonts default to off, and the
 *   payload's `caps` say so. A host may still pass its own providers to `createReader`.
 *   **Always resolves, whatever happened** — a non-zero exit, a program that is
 *   not installed, a child that exits without reading the `input` it was given.
 *   Callers read the failure out of `code` and `stderr`; none of them is in a
 *   position to catch one, so none of them is handed one.
 *
 * @property {(...parts: string[]) => string} join
 * @property {(p: string) => string} dirname
 * @property {(p: string) => string} basename
 * @property {(p: string) => string} resolve
 *   An absolute path. What "absolute" is relative to is the host's business:
 *   the CLI resolves against the working directory it was run from, and the app
 *   is only ever handed absolute paths in the first place. The store keys
 *   documents on the answer, so two spellings of one file must not survive
 *   this.
 *
 * @typedef {object} SpawnOptions
 * @property {string} [cwd]
 * @property {string} [input]     Written to stdin.
 * @property {number} [timeout]   Milliseconds.
 *
 * @typedef {object} SpawnResult
 * @property {number|null} code   Exit status; null if it was killed.
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * A path the way a person reads it: `~` for home, everything else exactly as
 * it is. Shortening a path outside home would only hide which volume a file is
 * on, which is the one thing that path is there to say.
 *
 * Here rather than in a paths module because it is the one piece of path prettifying
 * both hosts need, and the home directory is something only the host knows.
 */
export function homeRelative(p, home) {
  if (!p) return '';
  if (!home) return p;
  if (p === home) return '~';
  // Either separator: the app may be showing a path it was handed rather than
  // one it built.
  for (const sep of ['/', '\\']) {
    if (p.startsWith(home + sep)) return '~' + p.slice(home.length);
  }
  return p;
}
