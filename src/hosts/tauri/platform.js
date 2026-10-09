// The Tauri side of the platform contract: what the desktop app runs on.
//
// The counterpart of src/hosts/node/platform.js, and just as thin. The difference is
// where the disk is: there is no node here, so every call is a message to the
// Rust side (shell/src/host.rs), and that is the whole reason the contract is
// asynchronous. The interesting behaviour -- what the store does, what counts
// as a version, how git history is folded in -- is the same code either way.
import { invoke } from '@tauri-apps/api/core';

/** How often to look at a file's modification time. */
const POLL_MS = 250;

/**
 * What the shell handed over when it made the window.
 *
 * `os`, `env` and the path helpers are synchronous in the contract, and a
 * webview cannot call into Rust synchronously, so they cannot be asked for --
 * they arrive as a literal in an initialization script instead. A store key
 * built by awaiting a path separator would be a strange thing to write.
 */
const host = globalThis.__REDLINE_HOST ?? { os: 'darwin', home: '', env: {} };

const SEP = host.os === 'win32' ? '\\' : '/';

/**
 * Join, the way the host would.
 *
 * Not `p.join('/')`: the store writes these paths into its own index and hands
 * them back, so two spellings of one file would not fail loudly -- they would
 * file one document under two names.
 */
function join(...parts) {
  const out = parts
    .filter((p) => p !== '' && p != null)
    .join(SEP)
    // Any run of either separator collapses: the pieces being joined come from
    // both sides of this bridge and only one of them is careful about trailing
    // slashes.
    .replace(/[/\\]+/g, SEP);
  return out || '.';
}

/** Everything up to the last separator, or '.' when there is none. */
function dirname(p) {
  const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (at < 0) return '.';
  if (at === 0) return SEP; // '/x' -- the root, not the empty string
  return p.slice(0, at);
}

function basename(p) {
  const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return at < 0 ? p : p.slice(at + 1);
}

/**
 * An absolute path, normalised.
 *
 * There is no working directory to resolve against here -- the shell only ever
 * hands over paths it got from the OS, from a dialog or from a command line it
 * resolved itself. So this collapses `.` and `..` and leaves everything else,
 * which is what the store needs: it keys documents on the answer, and two
 * spellings of one file must not survive it.
 */
function resolve(p) {
  if (!p) return p;
  const win = /^[a-zA-Z]:[/\\]/.test(p);
  const rooted = win || p.startsWith('/') || p.startsWith('\\');
  const drive = win ? p.slice(0, 2) : '';
  const parts = [];
  for (const part of (win ? p.slice(2) : p).split(/[/\\]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !rooted) parts.push(part);
  }
  const body = parts.join(SEP);
  return rooted ? drive + SEP + body : body;
}

/** @type {import('../../reader/platform.js').Platform} */
export const tauriPlatform = {
  readText: (p) => invoke('read_text', { path: p }),
  writeText: (p, text) => invoke('write_text', { path: p, text }),
  mkdirp: (p) => invoke('mkdirp', { path: p }),
  readDir: (p) => invoke('read_dir', { path: p }),
  remove: (p) => invoke('remove', { path: p }),
  rename: (from, to) => invoke('rename', { from, to }),
  exists: (p) => invoke('exists', { path: p }),
  modified: (p) => invoke('modified', { path: p }),

  /**
   * Notice a change by looking at the file's date.
   *
   * A poll rather than a native watcher, and not for want of one. The contract
   * warns that watching a file and nothing else misses an editor's atomic save,
   * where a temp file is renamed over the top and the watch is left holding an
   * inode that is no longer the file -- which is why the node side watches the
   * directory. A stat of the path has never had that problem: it follows the
   * name. So the simplest implementation here is also the one with no way to go
   * deaf, and it costs one stat per open document a few times a second.
   *
   * Being a little noisy is allowed and is what makes this safe: the reader
   * compares the content before it believes anything happened, so a date that
   * moved without the bytes changing costs a read and nothing else.
   */
  async watch(p, onChange) {
    let last = await invoke('modified', { path: p });
    let stopped = false;
    const timer = setInterval(async () => {
      const now = await invoke('modified', { path: p });
      if (stopped || now === last) return;
      last = now;
      onChange();
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  },

  homeDir: async () => host.home,
  env: (name) => host.env[name],
  os: host.os,

  spawn: (cmd, args, { cwd, input, timeout } = {}) =>
    invoke('spawn', { cmd, args, cwd, input, timeout }),

  join,
  dirname,
  basename,
  resolve,
};
