// The node side of the platform contract: what the CLI runs on.
//
// Thin on purpose. Everything here is one call through to node, so that the
// interesting behaviour -- what the store does, what counts as a version, how
// git history is folded in -- lives in one place and is the same code the
// desktop app runs.
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

/** @type {import('../../reader/platform.js').Platform} */
export const nodePlatform = {
  async readText(p) {
    try {
      return await fs.readFile(p, 'utf8');
    } catch {
      return null;
    }
  },

  writeText: (p, text) => fs.writeFile(p, text),
  mkdirp: async (p) => void (await fs.mkdir(p, { recursive: true })),
  readDir: (p) => fs.readdir(p),
  remove: (p) => fs.rm(p, { force: true }),

  async rename(from, to) {
    try {
      await fs.rename(from, to);
      return true;
    } catch {
      return false;
    }
  },

  async exists(p) {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  },

  async modified(p) {
    try {
      return (await fs.stat(p)).mtimeMs;
    } catch {
      return null;
    }
  },

  // The directory, not the file: an editor saving atomically writes a temp
  // file and renames it over the top, which replaces the inode a watch on the
  // file is holding, and that watch then reports nothing ever again.
  async watch(p, onChange) {
    const w = watch(path.dirname(p), (_evt, name) => {
      if (!name || name === path.basename(p)) onChange();
    });
    return () => w.close();
  },

  homeDir: async () => os.homedir(),
  env: (name) => process.env[name],
  os: process.platform,

  // Resolved rather than rejected on a non-zero exit. Both callers care about
  // the output either way: git answering "not a repository" and the PlantUML
  // jar refusing a diagram are both things to read, not to catch.
  spawn(cmd, args, { cwd, input, timeout } = {}) {
    return new Promise((resolve) => {
      const child = execFile(
        cmd,
        args,
        { cwd, timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({
            code: err ? (err.code ?? null) : 0,
            stdout: stdout ?? '',
            stderr: stderr ?? (err ? String(err.message) : ''),
          });
        },
      );
      // A child that exits without reading leaves this pipe with no other end,
      // and the write comes back EPIPE — on a stream whose unhandled 'error'
      // takes the whole process down, with no way for a caller to catch it.
      // Which is not a failure anyone needs told twice: execFile's callback
      // already has the ENOENT or the exit code, and that is what is acted on.
      // A jar that is not a jar is the usual way in, so it is PlantUML that
      // finds this, and only on the machines where the child loses the race.
      child.stdin?.on('error', () => {});
      if (input != null) child.stdin?.end(input);
      else child.stdin?.end();
    });
  },

  join: (...parts) => path.join(...parts),
  dirname: (p) => path.dirname(p),
  basename: (p) => path.basename(p),
  resolve: (p) => path.resolve(p),
};
