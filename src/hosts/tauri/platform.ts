// The Tauri side of the platform contract: what the desktop app runs on.
//
// The counterpart of src/hosts/node/platform.ts, and just as thin. The difference is
// where the disk is: there is no node here, so every call is a message to the
// Rust side (shell/src/host.rs), and that is the whole reason the contract is
// asynchronous. The interesting behaviour -- what the store does, what counts
// as a version, how git history is folded in -- is the same code either way.
import { invoke } from '@tauri-apps/api/core';

import { makePaths } from '../../core/paths.js';
import type { Platform, SpawnResult } from '../../reader/platform.js';

/** How often to look at a file's modification time. */
const POLL_MS = 250;

/**
 * What the shell leaves on the window, field for field the `Handoff` in shell/src/host.rs.
 * Every field is always there when the global is; the modules that read it still tolerate its
 * absence, because they can be imported with no shell behind them.
 */
export interface Handoff {
  /** 'darwin' | 'win32' | 'linux'. */
  os: string;
  home: string;
  /** Only the few variables the reader reads (`WANTED` in host.rs). */
  env: Record<string, string>;
  /** Which window this page is: `w1`, `w2`. See `on` in native.ts. */
  label: string;
  version: string;
  /** Every document this window holds, and which of them is on screen. */
  files: string[];
  active: string | null;
  /** Whether this window is the one that sweeps the store on the way up. */
  gc: boolean;
}

declare global {
  // `var`: a `let` or `const` here would not be a property of `globalThis`.
  var __REDLINE_HOST: Handoff | undefined;
}

/**
 * What the shell handed over when it made the window.
 *
 * `os`, `env` and the path helpers are synchronous in the contract, and a
 * webview cannot call into Rust synchronously, so they cannot be asked for --
 * they arrive as a literal in an initialization script instead. A store key
 * built by awaiting a path separator would be a strange thing to write.
 */
const host: Pick<Handoff, 'os' | 'home' | 'env'> = globalThis.__REDLINE_HOST ?? {
  os: 'darwin',
  home: '',
  env: {},
};

const { join, dirname, basename, resolve } = makePaths(host.os === 'win32' ? '\\' : '/');

// The type argument on each `invoke` is the Rust command's return type (shell/src/host.rs), which
// `invoke` cannot know: left off, it answers `unknown` and the contract below would not hold.
export const tauriPlatform: Platform = {
  readText: (p) => invoke<string | null>('read_text', { path: p }),
  writeText: (p, text) => invoke<void>('write_text', { path: p, text }),
  mkdirp: (p) => invoke<void>('mkdirp', { path: p }),
  readDir: (p) => invoke<string[]>('read_dir', { path: p }),
  remove: (p) => invoke<void>('remove', { path: p }),
  rename: (from, to) => invoke<boolean>('rename', { from, to }),
  exists: (p) => invoke<boolean>('exists', { path: p }),
  modified: (p) => invoke<number | null>('modified', { path: p }),

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
    let last = await invoke<number | null>('modified', { path: p });
    let stopped = false;
    const timer = setInterval(async () => {
      const now = await invoke<number | null>('modified', { path: p });
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
    invoke<SpawnResult>('spawn', { cmd, args, cwd, input, timeout }),

  join,
  dirname,
  basename,
  resolve,
};
