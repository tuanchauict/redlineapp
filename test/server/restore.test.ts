import { test } from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert';
import { createServer } from '../../src/hosts/node/server.js';
import { createReader } from '../../src/reader/reader.js';
import { nodePlatform } from '../../src/hosts/node/platform.js';
import { SESSION_METHODS } from '../../src/rpc/protocol.js';
import { portOf, read, scratch } from '../support.js';

const tmp = scratch();

// A version put back as the file, in the one host that serves a browser tab and can write it.
test('restoring a version writes it as the file and keeps what it replaced', async () => {
  const file = path.join(tmp, 'restore.md');
  const v1 = '# Restore\n\nFirst wording.\n';
  const v2 = '# Restore\n\nSecond wording, thought better of.\n';
  fs.writeFileSync(file, v1);
  const srv = await createServer({ file });
  await new Promise<void>((r) => srv.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${portOf(srv.server)}`;
  const doc = async (): Promise<any> => (await fetch(`${base}/api/doc`)).json();
  try {
    assert.strictEqual((await doc()).caps.restore, true, 'the CLI host says it can restore');
    await doc();
    fs.writeFileSync(file, v2);
    await new Promise((r) => setTimeout(r, 700));
    const before = await doc();
    const first = before.history.find((h) => !h.current);
    assert.ok(first, 'the first wording is in History');

    const res = await fetch(`${base}/api/restore?hash=${first.hash}`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const after: any = await res.json();
    assert.strictEqual(fs.readFileSync(file, 'utf8'), v1, 'the file is the first wording again');
    assert.ok(after.history.find((h) => h.hash === first.hash).current, 'which is now the one on disk');
    assert.strictEqual(after.history.length, 2, 'and what it replaced is still a version');

    // Restoring the version that is already on disk writes nothing and says nothing is wrong.
    const again = await fetch(`${base}/api/restore?hash=${first.hash}`, { method: 'POST' });
    assert.strictEqual(again.status, 200);
    // A version the history does not hold is refused, and the file is left alone.
    const gone = await fetch(`${base}/api/restore?hash=${'0'.repeat(64)}`, { method: 'POST' });
    assert.ok(gone.status >= 400, 'an unknown version is an error');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), v1);
    const blank = await fetch(`${base}/api/restore`, { method: 'POST' });
    assert.strictEqual(blank.status, 400, 'naming no version is a bad request');
  } finally {
    srv.server.close();
  }
});

// A host that may not write the file says so, and is refused rather than trusted to hide a menu.
test('a host with no writeFile cannot restore, and says so', async () => {
  const file = path.join(tmp, 'readonly.md');
  fs.writeFileSync(file, '# Read only\n');
  const { writeFile: _drop, ...readOnly } = nodePlatform;
  const reader = await createReader({ platform: readOnly });
  const id = await reader.retain(file);
  try {
    assert.strictEqual((await reader.doc(id)).caps.restore, false);
    await assert.rejects(() => reader.restore(id, 'a'.repeat(64)), /cannot write the file/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '# Read only\n');
  } finally {
    reader.closeAll();
  }
});

test('restore is wired from the menu to the reader', () => {
  assert.ok(SESSION_METHODS.includes('restore'), 'a page may call it');
  assert.match(read('public/app/vm/history.ts'), /Restore this version…/);
  assert.match(read('public/app/vm/history.ts'), /state\.caps\?\.restore/, 'offered only where it can work');
  assert.match(read('public/app/main.ts'), /restore,\n\}\);/, 'handed to the list');
  assert.match(read('public/app/ui/History.tsx'), /<RestoreAsk /, 'and asks in the row');
  assert.match(read('src/rpc/client.ts'), /call<DocPayload>\('restore'/);
  assert.match(read('public/backend.ts'), /\/api\/restore/);
});
