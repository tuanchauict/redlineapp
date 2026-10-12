import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { createServer } from '../../src/hosts/node/server.js';
import type { Reply } from '../support.js';
import { clientFor, portOf, scratch, until } from '../support.js';

const tmp = scratch();

// git baseline.
const { execFileSync } = await import('node:child_process');

test('git HEAD baseline', async () => {
  const repo = fs.mkdtempSync(path.join(tmp, 'git-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  const tracked = path.join(repo, 'doc.md');
  fs.writeFileSync(tracked, '# Title\n\nCommitted paragraph.\n');
  git('add', 'doc.md');
  git('commit', '-qm', 'init');
  fs.writeFileSync(tracked, '# Title\n\nCommitted paragraph.\n\nUncommitted new paragraph.\n');

  const third = await createServer({ file: tracked });
  await new Promise<void>((r) => third.server.listen(0, '127.0.0.1', r));
  const gitDoc = await clientFor(`http://127.0.0.1:${portOf(third.server)}`)(
    '/api/doc?baseline=git:HEAD',
  );
  assert.ok(gitDoc.tracked, 'the file is known to be in a repo');
  assert.strictEqual(gitDoc.baseline, 'git:HEAD', 'git HEAD is honoured as a baseline');
  assert.deepStrictEqual(
    gitDoc.stats,
    { added: 1, removed: 0, modified: 0 },
    `git HEAD diff: ${JSON.stringify(gitDoc.stats)}`,
  );
  assert.match(gitDoc.html, /chg chg-add[\s\S]*Uncommitted new paragraph/);
  console.log('✓ git HEAD baseline', gitDoc.stats);
  third.server.close();
});

// A file outside a repo has no git baseline, and asking for one falls back
// rather than failing: the setting that asks for it is set once, for every file.
test('untracked file hides git baseline', async () => {
  const loose = path.join(tmp, 'loose.md');
  fs.writeFileSync(loose, '# Loose\n');
  const fourth = await createServer({ file: loose });
  await new Promise<void>((r) => fourth.server.listen(0, '127.0.0.1', r));
  const looseDoc = (await (
    await fetch(`http://127.0.0.1:${portOf(fourth.server)}/api/doc?baseline=git:HEAD`)
  ).json()) as Reply;
  assert.ok(!looseDoc.tracked, 'untracked file says so');
  assert.strictEqual(looseDoc.baseline, 'read', 'and git HEAD falls back to last read');
  fourth.server.close();
});

let git2, hist;
test('git history imported', async () => {
  const repo2 = fs.mkdtempSync(path.join(tmp, 'gitlog-'));
  git2 = (...a) => execFileSync('git', a, { cwd: repo2, stdio: 'ignore' });
  git2('init', '-q');
  git2('config', 'user.email', 'test@example.com');
  git2('config', 'user.name', 'test');
  hist = path.join(repo2, 'notes.md');
  fs.writeFileSync(hist, '# Notes\n\nFirst thought.\n');
  git2('add', 'notes.md');
  git2('commit', '-qm', 'first thought');
  fs.writeFileSync(hist, '# Notes\n\nFirst thought.\n\nSecond thought.\n');
  git2('commit', '-qam', 'second thought');
  fs.writeFileSync(hist, '# Notes\n\nFirst thought.\n\nSecond thought.\n\nThird thought.\n');
  git2('commit', '-qam', 'third thought');

  const gitSrv = await createServer({ file: hist });
  await new Promise<void>((r) => gitSrv.server.listen(0, '127.0.0.1', r));
  const baseG = `http://127.0.0.1:${portOf(gitSrv.server)}`;
  const getG = (p = '/api/doc') => clientFor(baseG)(p);

  const imported = await until(
    async () => {
      const d = await getG();
      return d.history.filter((h) => h.git).length >= 3 ? d : null;
    },
    'the committed history to be imported',
  );
  assert.deepStrictEqual(
    imported.history.filter((h) => h.git).map((h) => h.git.subject),
    ['third thought', 'second thought', 'first thought'],
    'every commit that touched the file, newest first, named by its subject',
  );
  assert.ok(
    imported.history.every((h) => !h.git || /^[0-9a-f]{40}$/.test(h.git.sha)),
    'each carries the commit it came from',
  );
  // The version on disk is the third commit, so it is one entry with a commit
  // name — not a second copy of the same bytes under a content hash.
  assert.strictEqual(imported.history.length, 3, 'the committed head is not duplicated');
  assert.ok(imported.history[0].current, 'the newest version is the one on disk');
  // Importing adds things to compare against; it does not decide what you have read.
  assert.deepStrictEqual(
    imported.stats,
    { added: 0, removed: 0, modified: 0 },
    'an import leaves the baseline where it was',
  );

  // ...and an imported version is a real version: diffable like any other.
  const first = imported.history.at(-1);
  const vsFirst = await getG('/api/doc?baseline=snap:' + first.hash);
  assert.strictEqual(vsFirst.stats.added, 2,
    `vs the first commit: ${JSON.stringify(vsFirst.stats)}`);
  console.log('✓ git history imported', imported.history.map((h) => h.git.sha.slice(0, 7)).join(' '));

  // ...and catches up on commits made while it was closed.
  gitSrv.server.close();
});

test('git history caught up after a commit made while closed', async () => {
  fs.writeFileSync(hist, '# Notes\n\nFirst thought.\n\nSecond thought.\n\nFourth thought.\n');
  git2('commit', '-qam', 'fourth thought');

  const gitSrv2 = await createServer({ file: hist });
  await new Promise<void>((r) => gitSrv2.server.listen(0, '127.0.0.1', r));
  const baseG2 = `http://127.0.0.1:${portOf(gitSrv2.server)}`;
  const caught = await until(
    async () => {
      const d = (await (await fetch(baseG2 + '/api/doc')).json()) as Reply;
      return d.history.some((h) => h.git?.subject === 'fourth thought') ? d : null;
    },
    'the commit made while the file was closed',
  );
  assert.strictEqual(caught.history.filter((h) => h.git).length, 4, 'one entry per commit, still');
  assert.strictEqual(caught.history[0].git.subject, 'fourth thought',
    'the new commit is the newest');
  // The versions read the first time round are not read again.
  assert.deepStrictEqual(
    caught.history.map((h) => h.git.subject),
    ['fourth thought', 'third thought', 'second thought', 'first thought'],
    'the earlier import is left alone',
  );
  gitSrv2.server.close();
});
