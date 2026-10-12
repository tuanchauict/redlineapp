import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert';
import { rootUrl } from '../../src/hosts/node/root.js';

// docs/web-app.md says what the code does.
// It is what a person reads before they trust a file to a browser, so a number or a name in it
// that the code has since changed is worse than no page: the next reader believes it. These are
// the things in it that a person would act on, held to the code they describe, and that it is
// reachable from the two indexes, since a page nobody links to is one nobody reads.
test('docs/web-app.md agrees with the code it describes, is linked, cites no plan', async () => {
  const read = (f) => fs.readFileSync(rootUrl(f), 'utf8');
  const doc = read('./docs/web-app.md');
  assert.match(read('./docs/README.md'), /\]\(web-app\.md\)/, 'docs/README.md links it');
  assert.match(read('./README.md'), /\]\(docs\/web-app\.md\)/, 'and so does the README');

  // Where the data lives: the database, and every store in it, by the name the code gives it.
  const { STORES } = await import('../../src/hosts/web/idb.js');
  assert.match(read('./src/hosts/web/idb.ts'), /^const DB_NAME = 'redline';$/m);
  assert.match(doc, /database called `redline`/, 'the database is named as the code names it');
  assert.deepStrictEqual(
    [...doc.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]),
    STORES,
    'every store, in the order the code makes them, and none that it does not',
  );

  // What a person would count on: what the web app opens, where the rest is, and how long an
  // edit takes to show. Read from the code that holds the number, the one place it is written.
  const MAC_APP_URL = read('./public/app/ui/Welcome.tsx').match(
    /^export const MAC_APP_URL = '([^']+)';$/m,
  )?.[1];
  assert.ok(MAC_APP_URL, 'the Mac app link is read from where the welcome draws it');
  assert.ok(
    !/Open folder|folders down/.test(doc) && /files, not folders/.test(doc),
    'it opens files, and the doc offers no folder',
  );
  assert.ok(doc.includes(`](${MAC_APP_URL})`), 'and links the Mac app where the welcome does');
  assert.match(read('./src/reader/reader.ts'), /^const POLL_MS = 1500;$/m);
  assert.ok(doc.includes('within about a second and a half'), 'a poll of 1500 ms');
  assert.match(read('./scripts/serve-webapp.mts'), /^const DEFAULT_PORT = 8081;$/m);
  assert.ok(doc.includes('http://127.0.0.1:8081'), 'and the address the server answers on');

  // The open files, under the key the code keeps them by. And the way to another file as the page
  // has it: the bar once had a folder button for the welcome, and a doc that still offers it sends
  // a person looking for something that is not there.
  const { OPEN_KEY } = await import('../../src/hosts/web/open-files.js');
  assert.ok(doc.includes(`under \`${OPEN_KEY}\``), 'the open files are kept where it says');
  assert.ok(!/folder button/.test(doc), 'and no button in the bar puts the welcome up');

  // The plan this was built to was kept out of the repository, so anything here that cites it
  // cites a document a reader of the repository cannot open. What it decided is in docs/. The
  // needle is built in two so that this file is not the match.
  //
  // `skills/` and CLAUDE.md are the author's own and are gitignored, so a checkout -- CI's --
  // has neither: they are read where they are and passed over where they are not.
  const plan = new RegExp(['web-and', 'vscode'].join('-'));
  const skip = new Set(['node_modules', 'vendor', 'dist', 'target', '.git']);
  const here = (f) => rootUrl(`${f}`);
  const files = (dir) =>
    !fs.existsSync(here(dir))
      ? []
      : fs.readdirSync(here(`${dir}/`), { withFileTypes: true }).flatMap((e) =>
        skip.has(e.name) ? [] : e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
  const dirs = ['src', 'public', 'scripts', 'shell/src', 'docs', 'site', '.github', 'skills'];
  const cited = [
    ...dirs.flatMap(files),
    'README.md',
    'CLAUDE.md',
    'test-smoke.ts',
  ].filter((f) => fs.existsSync(here(f)) && plan.test(read(`./${f}`)));
  assert.deepStrictEqual(cited, [], 'nothing cites the plan, which only the author can read');
});
