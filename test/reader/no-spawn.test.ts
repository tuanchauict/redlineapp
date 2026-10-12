import { test } from 'node:test';
import assert from 'node:assert';
import { makePaths } from '../../src/core/paths.js';
import { NO_GIT } from '../../src/reader/git.js';
import { createReader } from '../../src/reader/reader.js';
import { render } from '../support.js';

// A reader on a platform with no `spawn` -- nothing but a map of files. Nothing here may throw
// for want of git, PlantUML or a font list; the payload says what is missing instead.
test('a reader with no spawn opens, diffs and prunes, and says what it lacks', async () => {
  const pp = makePaths('/');
  const files = new Map();
  const dirs = new Set(['/']);
  let clock = 1;
  const under = (dir) => (dir.endsWith('/') ? dir : dir + '/');
  const memory = {
    readText: async (p) => files.get(p)?.text ?? null,
    writeText: async (p, text) => void files.set(p, { text, mtime: clock++ }),
    mkdirp: async (p) => void dirs.add(p),
    readDir: async (p) => [
      ...new Set(
        [...files.keys(), ...dirs]
          .filter((k) => k.startsWith(under(p)) && k !== p)
          .map((k) => k.slice(under(p).length).split('/')[0]),
      ),
    ],
    remove: async (p) => void files.delete(p),
    rename: async (from, to) => {
      if (!files.has(from)) return false;
      files.set(to, files.get(from));
      files.delete(from);
      return true;
    },
    exists: async (p) => files.has(p) || dirs.has(p),
    modified: async (p) => files.get(p)?.mtime ?? null,
    // The poll is what notices a change here; there is nothing to watch.
    watch: async () => () => {},
    homeDir: async () => '/home/me',
    env: (name) => ({ REDLINE_HOME: '/store' })[name],
    os: 'linux',
    ...pp,
  };
  assert.ok(!('spawn' in memory), 'a platform with no spawn at all, not one that throws');

  const doc = '/home/me/notes/a.md';
  files.set(doc, { text: '# Notes\n\nFirst.\n', mtime: clock++ });
  const mem = await createReader({ platform: memory, pollMs: 20 });
  const memId = await mem.retain(doc);
  const first = await mem.doc(memId, 'last:read');
  assert.deepStrictEqual(first.caps, { git: false, plantuml: false }, 'caps say what this host lacks');
  assert.strictEqual(first.tracked, false, 'no file is in a repo');
  assert.strictEqual(first.pathLabel, '~/notes/a.md', 'and the default label still shortens home');
  assert.deepStrictEqual(await mem.fonts(), [], 'no font list');
  assert.ok(
    ((await mem.plantumlSvg('A -> B')) as { error: string }).error,
    'a diagram says why it did not draw',
  );

  const changed = new Promise<void>((resolve) => {
    const stop = mem.subscribe(memId, (e) => e.type === 'change' && (stop(), resolve()));
  });
  await memory.writeText(doc, '# Notes\n\nFirst.\n\nSecond.\n');
  await changed;
  const second = render(await mem.doc(memId, 'read'));
  assert.deepStrictEqual(second.stats, { added: 1, removed: 0, modified: 0 }, 'it diffs');
  assert.strictEqual(second.history.length, 2, 'and keeps both versions');
  const oldest = second.history.find((h) => !h.current);
  const pruned = await mem.prune(memId, oldest.hash, 'read');
  assert.strictEqual(pruned.removed, 1, 'it prunes');
  assert.strictEqual(pruned.history.length, 1, 'down to the version on disk');
  mem.closeAll();

  // The providers are what a host brings: its own, or none.
  const calls = [];
  const custom = await createReader({
    platform: memory,
    git: { ...NO_GIT, info: async (p) => (calls.push(p), { root: '/', relPath: 'a.md' }) },
    plantuml: false,
    fonts: async () => ['Serif'],
    label: (abs) => ({ dirLabel: 'D', pathLabel: abs.split('/').at(-1) }),
  });
  const customId = await custom.retain(doc);
  const shown = await custom.doc(customId, 'last:read');
  assert.deepStrictEqual(calls, [doc], 'a provider is asked, not the default');
  assert.deepStrictEqual(shown.caps, { git: true, plantuml: false }, 'and it is what caps report');
  assert.deepStrictEqual([shown.dirLabel, shown.pathLabel], ['D', 'a.md'], 'the label is the host\'s');
  assert.deepStrictEqual(await custom.fonts(), ['Serif'], 'so are the fonts');
  custom.closeAll();
});
