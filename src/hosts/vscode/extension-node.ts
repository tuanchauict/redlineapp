// The extension's entry point, and what only node can answer for it: where home is, the
// environment, and running a program.
//
// The one file of this host that imports `node:`, so that everything else in it -- the platform,
// the page's HTML, the panel -- can be built and tested without a node built-in in reach. The
// spawn is hosts/node/platform.ts's, and copied because a host may not import another host:
// the layers are what keep a bundle for a page from pulling in `node:child_process`, and the
// test that holds them does not make an exception for twenty lines.
import os from 'node:os';
import { execFile } from 'node:child_process';

import type * as vscode from 'vscode';

import { activateWith } from './extension.js';
import type { NodeBits } from './platform.js';

export function nodeBits(): NodeBits {
  return {
    homeDir: async () => os.homedir(),
    env: (name) => process.env[name],
    os: process.platform,

    // Resolved rather than rejected on a non-zero exit: git answering "not a repository" and a
    // PlantUML jar refusing a diagram are both things to read, not to catch.
    spawn: (cmd, args, { cwd, input, timeout } = {}) =>
      new Promise((resolve) => {
        const child = execFile(
          cmd,
          args,
          { cwd, timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
          (err, stdout, stderr) => {
            resolve({
              code: err ? ((err as NodeJS.ErrnoException).code ?? null) : 0,
              stdout: stdout ?? '',
              stderr: stderr ?? (err ? String(err.message) : ''),
            });
          },
        );
        // A child that exits without reading leaves this pipe with no other end, and the write
        // comes back EPIPE on a stream whose unhandled 'error' takes the process down -- which
        // here is the extension host, and every other extension with it.
        child.stdin?.on('error', () => {});
        if (input != null) child.stdin?.end(input);
        else child.stdin?.end();
      }),
  };
}

export function activate(context: vscode.ExtensionContext): Promise<void> {
  return activateWith(context, nodeBits());
}

export function deactivate(): void {}
