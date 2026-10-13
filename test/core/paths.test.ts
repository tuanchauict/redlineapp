import { test } from 'node:test';
import path from 'node:path';
import assert from 'node:assert';
import { makePaths } from '../../src/core/paths.js';

// core/paths.js agrees with node:path on the cases it claims. Not claimed: a trailing
// separator on dirname, and the root of a drive (`C:\a` has dirname `C:`, node says `C:\`).
// Nothing is resolved against a working directory, so only absolute paths are compared.
test('core/paths.js agrees with node:path', async () => {
  const posixPaths = makePaths('/');
  const winPaths = makePaths('\\');
  for (const [paths, ref, cases] of [
    [posixPaths, path.posix, {
      join: [['a', 'b'], ['/a/', '/b'], ['/a', '', 'b'], ['/a//b', 'c.md'], [], ['', '']],
      dirname: ['/a/b.md', '/a', '/a/b/c', 'b.md'],
      basename: ['/a/b.md', 'b.md', '/a/b'],
      resolve: ['/a/./b/../c', '/a//b', '/..', '/a/b/..', '/', '/a/../../b'],
    }],
    [winPaths, path.win32, {
      join: [['C:\\a', 'b'], ['C:\\a\\', '\\b'], ['C:/a', 'b'], ['C:\\a', '', 'b']],
      dirname: ['C:\\a\\b.md', 'C:\\a\\b\\c', 'b.md'],
      basename: ['C:\\a\\b.md', 'b.md'],
      resolve: ['C:\\a\\.\\b\\..\\c', 'C:/a/b', 'C:\\', 'C:\\..', 'C:\\a\\\\b'],
    }],
  ] as const) {
    for (const args of cases.join) {
      assert.strictEqual(paths.join(...args), ref.join(...args), `join ${JSON.stringify(args)}`);
    }
    for (const fn of ['dirname', 'basename', 'resolve']) {
      for (const p of cases[fn]) assert.strictEqual(paths[fn](p), ref[fn](p), `${fn} ${p}`);
    }
  }
  assert.deepStrictEqual([posixPaths.sep, winPaths.sep], ['/', '\\'], 'each carries its separator');
});
