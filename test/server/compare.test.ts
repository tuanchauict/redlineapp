import { test } from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert';
import { createServer } from '../../src/hosts/node/server.js';
import { portOf, read, scratch } from '../support.js';

const tmp = scratch();

// Two versions compared with each other, neither of them the file.
test('a document can be asked for its text as of an older version, and says which', async () => {
  const file = path.join(tmp, 'compare.md');
  const texts = ['# C\n\nOne.\n', '# C\n\nTwo.\n', '# C\n\nThree.\n'];
  fs.writeFileSync(file, texts[0]);
  const srv = await createServer({ file });
  await new Promise<void>((r) => srv.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${portOf(srv.server)}`;
  const doc = async (q = ''): Promise<any> => (await fetch(`${base}/api/doc${q}`)).json();
  try {
    await doc();
    for (const t of texts.slice(1)) {
      fs.writeFileSync(file, t);
      await new Promise((r) => setTimeout(r, 700));
      await doc();
    }
    const d = await doc();
    assert.strictEqual(d.to, null, 'no second end unless asked');
    assert.strictEqual(d.toText, null);
    const [, mid, old] = d.history;
    const q = `?baseline=snap:${old.hash}&to=${mid.hash}`;
    const between = await doc(q);
    assert.strictEqual(between.toText, texts[1], 'the newer end is the version named');
    assert.strictEqual(between.to, mid.hash);
    assert.strictEqual(between.base, texts[0], 'the older end is the baseline');
    assert.strictEqual(between.text, texts[2], 'and the file is still the file');
    const cur = await doc(`?baseline=snap:${old.hash}&to=${d.hash}`);
    assert.strictEqual(cur.toText, null, 'the file as the newer end is no second end');
    const gone = await doc(`?to=${'0'.repeat(64)}`);
    assert.strictEqual(gone.toText, null, 'a version not kept is ignored');
  } finally {
    srv.server.close();
  }
});

// The page is wired to it: a diff that is correct and unreachable would pass the above.
test('the page sends the second end back and offers a way to pick it', () => {
  assert.match(read('public/app/vm/core.ts'), /backend\.doc\(state\.baseline, state\.compareTo\)/);
  assert.match(read('public/app/ui/History.tsx'), /span: e\.shiftKey/);
  assert.match(read('public/app/vm/history.ts'), /Compare to this version/);
  assert.match(read('public/backend.ts'), /to \}\)/);
});
