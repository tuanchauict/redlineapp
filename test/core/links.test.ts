import { test } from 'node:test';
import assert from 'node:assert';
import { walkPath, shorten } from '../../src/core/links.js';

// core/links.js. The CLI's cases are held against the function as it was in app.js, so that
// moving it was a move; the rest are the places a document can now live.
test('core/links.js: the CLI cases are unchanged, the others work', async () => {
  const legacyWalk = (dir, rel) => {
    const parts = dir.split('/');
    for (const seg of rel.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg !== '..') parts.push(seg);
      else if (parts.length > 1) parts.pop();
    }
    return parts.join('/') || '/';
  };
  const legacyShorten = (abs, d) => {
    const cut = d.dirLabel.startsWith('~') ? d.dir.length - d.dirLabel.length + 1 : -1;
    const home = cut >= 0 ? d.dir.slice(0, cut) : '';
    if (!home) return abs;
    if (abs === home) return '~';
    return abs.startsWith(home + '/') ? '~' + abs.slice(home.length) : abs;
  };
  for (const dir of ['/', '/a', '/a/b', '/Users/me/notes']) {
    for (const rel of ['c.md', './c.md', '../c.md', '../../c.md', '../../../../c.md', 'x/./y/../z.md',
      '', '.', '..', 'a//b.md']) {
      // A dir of `/` is not compared: it used to come back as `//c.md`.
      if (dir === '/') continue;
      assert.strictEqual(walkPath(dir, rel), legacyWalk(dir, rel), `${dir} + ${rel}`);
    }
  }
  assert.strictEqual(walkPath('/', 'a.md'), '/a.md', 'a file in the root is /a.md, not //a.md');
  assert.strictEqual(walkPath('/', '../../a.md'), '/a.md', 'and the root has nothing above it');
  for (const d of [
    { dir: '/Users/me/notes', dirLabel: '~/notes' },
    { dir: '/Users/me', dirLabel: '~' },
    { dir: '/var/log', dirLabel: '/var/log' },
    { dir: '/Users/me/footnotes', dirLabel: '~/footnotes' },
  ]) {
    for (const abs of ['/Users/me', '/Users/me/x.md', '/Users/me/notes/y.md', '/Users/mex/y.md',
      '/Users/other/y.md', '/etc/x', '/', '/var/log/z.log']) {
      assert.strictEqual(shorten(abs, d), legacyShorten(abs, d), `${abs} in ${d.dir}`);
    }
  }

  assert.strictEqual(walkPath('C:\\notes\\sub', '..\\x.md'), 'C:\\notes\\x.md', 'a drive path');
  assert.strictEqual(walkPath('C:\\notes', 'a/b.md'), 'C:\\notes\\a\\b.md',
    'keeps its separator when the link is written with the other one');
  assert.strictEqual(walkPath('C:\\notes', '..\\..\\..\\x.md'), 'C:\\x.md', '.. stops at the drive');
  assert.strictEqual(walkPath('C:\\', 'a.md'), 'C:\\a.md', 'the root of a drive');
  assert.strictEqual(walkPath('web:r1/docs', '../../../x.md'), 'web:r1/x.md',
    'a link cannot climb out of the folder the web app was given');
  assert.strictEqual(walkPath('web:r1', 'a.md'), 'web:r1/a.md', 'the root itself');
  assert.strictEqual(walkPath('file:///a/b', '../c.md'), 'file:///a/c.md', 'a file: URI');
  assert.strictEqual(
    walkPath('vscode-remote://ssh-remote+box/home/me', '../../../../etc/x.md'),
    'vscode-remote://ssh-remote+box/etc/x.md',
    'and a remote one, which keeps its authority',
  );
  assert.strictEqual(walkPath('/a/b', 'c\\d.md'), '/a/b/c\\d.md',
    'a backslash on a POSIX path is part of a name');

  assert.strictEqual(
    shorten('C:\\Users\\me\\x.md', { dir: 'C:\\Users\\me\\notes', dirLabel: '~\\notes' }),
    '~\\x.md',
    'home on Windows',
  );
  assert.strictEqual(
    shorten('vscode-remote://box/home/me/a.md', {
      dir: 'vscode-remote://box/home/me/notes',
      dirLabel: '~/notes',
    }),
    '~/a.md',
    'home behind a URI',
  );
  assert.strictEqual(
    shorten('web:r1/x.md', { dir: 'web:r1/docs', dirLabel: 'r1/docs' }),
    'r1/x.md',
    'a label that is not home is taken from the pair, not assumed',
  );
});
