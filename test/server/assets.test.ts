import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { rootUrl } from '../../src/hosts/node/root.js';
import { scratch, serve } from '../support.js';

// The sample, copied, so that nothing a check does can reach the one in the repository.
const tmp = scratch();
const file = path.join(tmp, 'sample.md');
fs.copyFileSync(rootUrl('sample.md'), file);
const { base } = await serve(file);

// Static assets.
test('static assets serve (incl. mermaid bundle + chunks)', async () => {
  for (const asset of [
    '/',
    '/app.js',
    '/styles.css',
    '/vendor/github-markdown.css',
    '/vendor/hljs-light.css',
    '/vendor/hljs-dark.css',
    '/vendor/mermaid/mermaid.esm.min.mjs',
    '/vendor/sanitize.js',
    '/icon.svg',
  ]) {
    const r = await fetch(base + asset);
    assert.strictEqual(r.status, 200, `${asset} serves`);
    assert.ok((await r.text()).length > 100, `${asset} is non-empty`);
  }
  // The favicon needs its real type or the browser ignores it.
  assert.match(
    (await fetch(base + '/icon.svg')).headers.get('content-type'),
    /image\/svg\+xml/,
    'icon served as SVG',
  );
  assert.strictEqual((await fetch(base + '/nope')).status, 404, 'unknown path 404s');

  // mermaid lazy-loads chunks relative to its own URL; they must resolve too
  const bundle = await (await fetch(base + '/vendor/mermaid/mermaid.esm.min.mjs')).text();
  const chunk = bundle.match(/from"(\.\/chunks\/[^"]+)"/)?.[1];
  assert.ok(chunk, 'bundle imports relative chunks');
  const chunkRes = await fetch(base + '/vendor/mermaid/' + chunk.slice(2));
  assert.strictEqual(chunkRes.status, 200, `mermaid chunk ${chunk} serves`);
  assert.match(
    chunkRes.headers.get('content-type'),
    /javascript/,
    'chunks served as javascript (browsers refuse modules otherwise)',
  );
  // must not escape the mermaid dist directory
  assert.strictEqual(
    (await fetch(base + '/vendor/mermaid/../../../package.json')).status,
    404,
    'no path traversal out of the mermaid mount',
  );
});
