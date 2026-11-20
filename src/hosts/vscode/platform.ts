// The VS Code extension host's side of the platform contract: the disk, as `vscode.workspace.fs`
// sees it.
//
// Through `workspace.fs` and not `node:fs` so that a document in a remote window, a container or
// a virtual workspace is read where it lives; the extension host runs next to the files, and the
// API is the one way that is true everywhere. What only node can do -- run a program, say where
// home is -- comes in as `NodeBits` from extension-node.ts, which is the one file of this host
// allowed to import `node:`.
//
// The `vscode` module is *handed in*, not imported, for the same reason the web platform is built
// over a key-value store: the test suite runs in node, where there is no `vscode` to import, and
// a platform that cannot be constructed without the editor is a platform nobody can test.
import type * as vscode from 'vscode';

import { makePaths } from '../../core/paths.js';
import type { Platform } from '../../reader/platform.js';

/** What this file reaches for on the `vscode` module. */
export type VscodeApi = Pick<typeof vscode, 'Uri' | 'workspace' | 'RelativePattern'>;

/** The parts of the platform that are node's to answer. */
export interface NodeBits {
  homeDir: Platform['homeDir'];
  env: Platform['env'];
  os: string;
  spawn?: Platform['spawn'];
}

// `scheme://authority`: the part of an address that is not a path, and that `..` must not pop.
const URI_ROOT = /^[a-z][a-z0-9+.-]*:\/\/[^/\\]*/i;

/**
 * Whether `p` is an address (`vscode-vfs://github/o/r/a.md`) and not a path on this machine.
 * A document on the local disk goes by its plain path -- `/home/me/a.md`, `C:\notes\a.md` --
 * which is what git can be run in and what `~` can shorten; only a file the editor reaches
 * through some other provider goes by its URI.
 */
export const isRemoteAddress = (p: string): boolean => URI_ROOT.test(p);

/** The editor's name for `p`, whichever of the two it is. */
export const toUri = (vs: Pick<VscodeApi, 'Uri'>, p: string): vscode.Uri =>
  isRemoteAddress(p) ? vs.Uri.parse(p) : vs.Uri.file(p);

/** The string a document is filed under, from the editor's address for it. */
export const fromUri = (uri: vscode.Uri): string =>
  uri.scheme === 'file' ? uri.fsPath : uri.toString(true);

let tmpSeq = 0;

export function createVscodePlatform(vs: VscodeApi, node: NodeBits): Platform {
  const fs = vs.workspace.fs;
  const uri = (p: string) => toUri(vs, p);
  const local = makePaths(node.os === 'win32' ? '\\' : '/');
  const posix = makePaths('/');

  // An address splits into its root and a posix path; anything else is a path on this machine, in
  // the separator its OS uses. Joined back, so that the store's index is written with one spelling
  // of a file whichever door it came in by.
  const split = (p: string): [string, string] => {
    const m = URI_ROOT.exec(p);
    return m ? [m[0], p.slice(m[0].length) || '/'] : ['', p];
  };

  const notFound = (err: any) => err?.code === 'FileNotFound' || err?.code === 'ENOENT';

  return {
    async readText(p) {
      try {
        return new TextDecoder().decode(await fs.readFile(uri(p)));
      } catch {
        return null;
      }
    },

    // Whole or not at all, as the contract asks: written beside the target and renamed over it.
    // `workspace.fs.writeFile` truncates in place, and the store's index is shared with the CLI
    // and the app, either of which may read it at any moment.
    async writeText(p, text) {
      const tmp = uri(`${p}.${Date.now().toString(36)}-${tmpSeq++}.writing`);
      try {
        await fs.writeFile(tmp, new TextEncoder().encode(text));
        await fs.rename(tmp, uri(p), { overwrite: true });
      } catch (err) {
        await Promise.resolve(fs.delete(tmp)).catch(() => {});
        throw err;
      }
    },
    mkdirp: async (p) => void (await fs.createDirectory(uri(p))),
    readDir: async (p) => (await fs.readDirectory(uri(p))).map(([name]) => name),
    async remove(p) {
      try {
        await fs.delete(uri(p), { recursive: true, useTrash: false });
      } catch (err) {
        if (!notFound(err)) throw err;
      }
    },

    async rename(from, to) {
      try {
        await fs.rename(uri(from), uri(to), { overwrite: true });
        return true;
      } catch {
        return false;
      }
    },

    async exists(p) {
      try {
        await fs.stat(uri(p));
        return true;
      } catch {
        return false;
      }
    },

    async modified(p) {
      try {
        return (await fs.stat(uri(p))).mtime;
      } catch {
        return null;
      }
    },

    // The directory, not the file, for the reason every host gives: an atomic save replaces the
    // file under its name. Best effort, and said to be: the editor may not watch a folder outside
    // the workspace, and the reader's own poll is what notices then.
    async watch(p, onChange) {
      try {
        const [root, rest] = split(p);
        const dir = root ? uri(root + posix.dirname(rest)) : uri(local.dirname(p));
        const w = vs.workspace.createFileSystemWatcher(new vs.RelativePattern(dir, '*'));
        const subs = [w.onDidChange(onChange), w.onDidCreate(onChange), w.onDidDelete(onChange)];
        return () => {
          for (const s of subs) s.dispose();
          w.dispose();
        };
      } catch {
        return () => {};
      }
    },

    homeDir: node.homeDir,
    env: node.env,
    os: node.os,
    ...(node.spawn && { spawn: node.spawn }),

    join(...parts) {
      const [root, first] = split(parts[0] ?? '');
      return root ? root + posix.join(first, ...parts.slice(1)) : local.join(...parts);
    },
    dirname(p) {
      const [root, rest] = split(p);
      return root ? root + posix.dirname(rest) : local.dirname(p);
    },
    basename(p) {
      const [root, rest] = split(p);
      return root ? posix.basename(rest) : local.basename(p);
    },
    resolve(p) {
      const [root, rest] = split(p);
      return root ? root + posix.resolve(rest) : local.resolve(p);
    },
  };
}
