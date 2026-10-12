import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { createMarkdown } from '../../src/core/render.js';
import type { AckedVersion } from '../../src/contract/payload.js';
import { nodePlatform } from '../../src/hosts/node/platform.js';
import { rootUrl } from '../../src/hosts/node/root.js';
import { renderDiff, blockId } from '../../src/core/diff.js';
import { hashContent } from '../../src/core/hash.js';
import { createReader } from '../../src/reader/reader.js';
import { DocStore } from '../../src/reader/store.js';
import { pageJs, render, scratch } from '../support.js';

const tmp = scratch();

// 5b'. a checked-off change becomes that block's own baseline.
// Check a block off, have it edited, and what comes back is what moved since
// you checked it — not the whole block replayed against the baseline, which is
// still where everything else is measured from. See docs/changes.md.
test('a checked-off change becomes that block\'s own baseline', async () => {
  {
    const mdAck = createMarkdown();
    const added = (html) => [...html.matchAll(/<ins class="w-add">([\s\S]*?)<\/ins>/g)].map((m) => m[1]);
    const read = 'The release paragraph, written for the team.';
    const now = 'The release paragraph, written for the whole team today.';
    // A version without its `hash`: renderDiff reads only `text` and `blocks` of each (see
    // seenBlocks), and the payload type asks for the hash as well.
    const from = (text) =>
      [{ text: `# Doc\n\n${text}\n`, blocks: [blockId(text)] }] as AckedVersion[];

    // An addition, checked off and then edited: changed, and only the new words.
    const sinceAdd = renderDiff(mdAck, '# Doc\n', `# Doc\n\n${now}\n`, [], { from: from(read) });
    assert.deepStrictEqual(sinceAdd.stats, { added: 0, removed: 0, modified: 1 }, 'counted as ~, which is what is drawn');
    assert.match(sinceAdd.html, /data-chg="mod"[^>]*>[\s\S]*chg-inline|chg-inline[^>]*data-chg="mod"/, 'and drawn inline');
    assert.ok(added(sinceAdd.html).join(' ').includes('whole'), 'the new words are marked');
    assert.ok(!added(sinceAdd.html).join(' ').includes('release'), 'and the words already read are not');
    assert.strictEqual(sinceAdd.changes[0].block, blockId(now), 'and the change names its block for the next check-off');

    // A change, checked off and edited again: the newest edit, not the first one.
    const was = 'The release paragraph, written for a team.';
    const sinceMod = renderDiff(mdAck, `# Doc\n\n${was}\n`, `# Doc\n\n${now}\n`, [], { from: from(read) });
    const removed = (html) => [...html.matchAll(/<del class="w-del">([\s\S]*?)<\/del>/g)].map((m) => m[1]);
    assert.deepStrictEqual(removed(sinceMod.html), ['team.'], 'the edit already checked is not replayed');
    assert.ok(added(sinceMod.html).join(' ').includes('whole'), 'the one since is shown');

    // Without the version the check-off was made in, nothing to diff against:
    // plain "added", as before, and no throw.
    const orphan = renderDiff(mdAck, '# Doc\n', `# Doc\n\n${now}\n`, [], { from: [] });
    assert.deepStrictEqual(orphan.stats, { added: 1, removed: 0, modified: 0 }, 'an orphaned check-off degrades to added');

    // A block checked off as it stands is still what was read, and must not be
    // claimed by some other check-off that has lapsed and happens to resemble it.
    const asIs = renderDiff(mdAck, '# Doc\n', `# Doc\n\n${now}\n`, [], {
      keys: ['add' + hashContent(now).slice(0, 10)],
      from: from(read),
    });
    assert.match(asIs.html, /data-chg="add"/, 'a block still checked as it stands stays an addition');
    assert.strictEqual(asIs.changes[0].key, 'add' + hashContent(now).slice(0, 10), 'under the key it was checked as');

    // A baseline edit closer to the file than any check-off is a baseline edit.
    const tenMin = 'The cache is flushed every ten minutes by the worker.';
    const fiveMin = 'The cache is flushed every five minutes by the worker.';
    const other = 'The cache is warmed once on boot by the worker process.';
    const unrelated = renderDiff(mdAck, `# Doc\n\n${tenMin}\n`, `# Doc\n\n${fiveMin}\n`, [], { from: from(other) });
    assert.ok(unrelated.html.includes('w-del">ten<'), 'a resembling check-off does not displace the baseline');

    // The same, end to end: a real store, a real reader, the file moving under it.
    const ackFile = path.join(tmp, 'acked.md');
    fs.writeFileSync(ackFile, '# Doc\n');
    const reader = await createReader({ platform: nodePlatform });
    const id = await reader.retain(ackFile);
    const edit = (text) =>
      new Promise<void>((resolve) => {
        const stop = reader.subscribe(id, (e) => e.type === 'change' && (stop(), resolve()));
        fs.writeFileSync(ackFile, text);
      });
    const show = async () => render(await reader.doc(id, 'read'));
    const check = (d, c) => reader.ack(id, { key: c.key, at: d.hash, block: c.block });
    const objects = path.join(process.env.REDLINE_HOME, 'objects');

    await edit(`# Doc\n\n${read}\n`);
    const v1 = await show();
    assert.deepStrictEqual(v1.stats, { added: 1, removed: 0, modified: 0 }, 'an addition to begin with');
    await check(v1, v1.changes[0]);

    await edit(`# Doc\n\n${now}\n`);
    const v2 = await show();
    assert.deepStrictEqual(v2.ackedFrom.map((v) => v.hash), [v1.hash], 'the version it was checked in travels with the document');
    assert.deepStrictEqual(v2.stats, { added: 0, removed: 0, modified: 1 }, 'checked, edited: changed, not added');
    assert.ok(!added(v2.html).join(' ').includes('release'), 'showing only what moved since');

    // An object that has gone — a store from before gc knew about check-offs, a
    // hand tidy — is a check-off with nothing to read back.
    const v1Object = path.join(objects, v1.hash + '.md');
    fs.renameSync(v1Object, v1Object + '.away');
    const gone = await show();
    assert.deepStrictEqual(gone.ackedFrom, [], 'an unreadable version is left out quietly');
    assert.deepStrictEqual(gone.stats, { added: 1, removed: 0, modified: 0 }, 'and the block is plain added again');
    fs.renameSync(v1Object + '.away', v1Object);

    await check(v2, v2.changes[0]);
    const later = `# Doc\n\n${now.replace('today.', 'today, before Friday.')}\n`;
    await edit(later);
    const v3 = await show();
    assert.deepStrictEqual(v3.stats, { added: 0, removed: 0, modified: 1 }, 'checked again, edited again: still changed');
    assert.ok(added(v3.html).join(' ').includes('Friday'), 'with the newest words marked');
    assert.ok(!added(v3.html).join(' ').includes('whole'), 'and not the ones checked last time');

    // Forgetting the version a check-off was made in is tidying the list; the
    // object behind it stays, or the feature stops working for whoever tidies.
    const v0 = v1.history.find((h) => !h.current);
    // Past the grace period gc gives a young object, or there would be nothing to sweep.
    const aged = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(path.join(objects, v0.hash + '.md'), aged, aged);
    await reader.prune(id, v1.hash, 'read');
    assert.ok(!fs.existsSync(path.join(objects, v0.hash + '.md')), 'gc ran');
    assert.ok(fs.existsSync(v1Object), 'and kept the version a check-off reads back from');

    // "All of this is seen" subsumes every "that bit is seen".
    const marked = render(await reader.markRead(id));
    assert.deepStrictEqual([marked.acked, marked.ackedFrom], [[], []], 'marking read clears the check-offs');

    // An older version is "I have read up to here", which says nothing about what
    // came after it: the mark goes back to it, and a check-off on a change made
    // since is still a check-off.
    await edit(`${later}\nA line written after the read, and then checked off.\n`);
    const v5 = await show();
    await check(v5, v5.changes[0]);
    assert.ok(!v5.history.find((h) => h.hash === v2.hash)?.baseline, 'v2 is an older version, not the one read');
    const upTo = render(await reader.markRead(id, v2.hash));
    assert.strictEqual(upTo.history.find((h) => h.baseline)?.hash, v2.hash, 'the read mark moves to the version named');
    assert.strictEqual(upTo.base, `# Doc\n\n${now}\n`, 'and the marks are measured from it');
    assert.deepStrictEqual(upTo.acked, [v5.changes[0].key], 'with the check-off made since kept');
    // A row drawn before another window forgot its version: nothing moves, and
    // the list that comes back says why.
    const stale = render(await reader.markRead(id, 'f'.repeat(16)));
    assert.strictEqual(stale.history.find((h) => h.baseline)?.hash, v2.hash, 'a version not in the history moves nothing');
    assert.deepStrictEqual(stale.acked, upTo.acked, 'and clears nothing');
    // Naming the version on disk is the plain mark-read, check-offs and all.
    const named = render(await reader.markRead(id, v5.hash));
    assert.ok(named.history.find((h) => h.baseline)?.current, 'the version on disk, named, is marked read');
    assert.deepStrictEqual(named.acked, [], 'and takes the check-offs with it, as it always has');
    reader.closeAll();

    // Check-offs written before they carried a version are kept, as keys.
    // Written to the index itself, as an older version of the app left it: a change is applied to
    // the index on disk, so poking the store's memory would be undone by the next one.
    const legacyPath = path.join(tmp, 'legacy.md');
    const seed = await DocStore.open(legacyPath, nodePlatform);
    fs.writeFileSync(
      seed.file,
      JSON.stringify({ path: legacyPath, history: [], baseline: null, acked: ['addold0000001', 'mod0000000002'] }),
    );
    const legacy = await DocStore.open(legacyPath, nodePlatform);
    assert.deepStrictEqual(legacy.acked, ['addold0000001', 'mod0000000002'], 'bare string acks still read');
    assert.deepStrictEqual(legacy.ackRecords, [{ key: 'addold0000001' }, { key: 'mod0000000002' }], 'as records with no version');
    await legacy.record('# Legacy\n');
    const held = legacy.latest.hash;
    await legacy.setAcked('addnew0000003', true, { at: held, block: 'abcdef0123' });
    await legacy.setAcked('addbad0000004', true, { at: '../../../etc/passwd', block: 'abcdef0123' });
    assert.deepStrictEqual(
      legacy.ackRecords,
      [
        { key: 'addold0000001' },
        { key: 'mod0000000002' },
        { key: 'addnew0000003', at: held, block: 'abcdef0123' },
        { key: 'addbad0000004' },
      ],
      'old ones survive a new check-off, and a version that is not one of ours is not kept',
    );
  }
  const serverJsSrc = fs.readFileSync(rootUrl('src/hosts/node/server.ts'), 'utf8');
  assert.match(serverJsSrc, /at: param\('at'\)/, 'the server passes the version a change was checked in');
  assert.match(pageJs, /backend\.ack\(\{ key, on, at: state\.data\?\.hash, block \}\)/, 'and the page sends it');
  assert.match(pageJs, /from: data\.ackedFrom/, 'and renders against what came back');
});
