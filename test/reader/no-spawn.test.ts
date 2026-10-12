import { test } from 'node:test';
import assert from 'node:assert';
import { makePaths } from '../../src/core/paths.js';
import { NO_GIT } from '../../src/reader/git.js';
import { createReader } from '../../src/reader/reader.js';
import { render } from '../support.js';

// A platform with no `spawn` -- nothing but a map of files. `notify` is the OS saying a file
// moved, which is all a watcher callback ever says.
function memoryPlatform() {
  const pp = makePaths('/');
  const files = new Map();
  const dirs = new Set(['/']);
  let clock = 1;
  const watchers = [];
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
    // The poll is what notices a change here, unless a test plays the OS through `notify`.
    watch: async (_p, fn) => (watchers.push(fn), () => {}),
    homeDir: async () => '/home/me',
    env: (name) => ({ REDLINE_HOME: '/store' })[name],
    os: 'linux',
    ...pp,
  };
  const notify = () => watchers.forEach((fn) => fn());
  return { memory, files, watchers, notify, clock: () => clock++ };
}

// A reader on that platform. Nothing here may throw for want of git, PlantUML or a font list; the
// payload says what is missing instead.
test('a reader with no spawn opens, diffs and prunes, and says what it lacks', async () => {
  const { memory, files, clock } = memoryPlatform();
  assert.ok(!('spawn' in memory), 'a platform with no spawn at all, not one that throws');

  const doc = '/home/me/notes/a.md';
  files.set(doc, { text: '# Notes\n\nFirst.\n', mtime: clock() });
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

// The watcher, driven by hand: the poll is set too slow to see anything, so every read is one the
// OS asked for, and what the reader does with a file that is briefly not there is all its own.
test('a save that replaces the file is waited out, but a file gone stays gone', async () => {
  const { memory, files, notify, clock } = memoryPlatform();
  const doc = '/home/me/notes/a.md';
  files.set(doc, { text: 'One.\n', mtime: clock() });
  const r = await createReader({ platform: memory, pollMs: 1e6 });
  const id = await r.retain(doc);
  const heard = [];
  r.subscribe(id, (e) => heard.push(e.type));
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));

  // Write a temporary, rename it over: for a moment the path is not there.
  files.delete(doc);
  notify();
  await wait(120);
  files.set(doc, { text: 'Two.\n', mtime: clock() });
  await wait(200);
  assert.deepStrictEqual(heard, ['change'], 'the file back a read later is the change it was');
  assert.strictEqual(r.pathOf(id), doc, 'and the document is still open');

  files.delete(doc);
  notify();
  await wait(500);
  files.set(doc, { text: 'Three.\n', mtime: clock() });
  await wait(200);
  assert.deepStrictEqual(heard, ['change'], 'a few reads with nothing there is given up on');
  r.closeAll();
});

test('two opens of one file at once are one document', async () => {
  const { memory, files, watchers, clock } = memoryPlatform();
  const doc = '/home/me/notes/a.md';
  files.set(doc, { text: 'One.\n', mtime: clock() });
  const r = await createReader({ platform: memory, pollMs: 1e6 });
  const [a, b] = await Promise.all([r.retain(doc), r.retain(doc)]);
  assert.strictEqual(a, b, 'the same id');
  assert.strictEqual(watchers.length, 1, 'one watcher, not a second evicting the first');
  r.release(a);
  assert.strictEqual(r.pathOf(a), doc, 'and two holders, so letting go once keeps it open');
  r.release(a);
  assert.strictEqual(r.pathOf(a), null, 'and the second closes it');

  // The first open failing is not the second's answer: it looks again, and fails on its own.
  const gone = '/home/me/notes/gone.md';
  const both = await Promise.allSettled([r.retain(gone), r.retain(gone)]);
  assert.deepStrictEqual(both.map((o) => o.status), ['rejected', 'rejected'],
    'a file that cannot be read fails for both');
  files.set(gone, { text: 'Here now.\n', mtime: clock() });
  assert.ok(await r.retain(gone), 'and nothing is left half-open to stop the next try');
  r.closeAll();
});
