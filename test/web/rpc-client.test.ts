import { test } from 'node:test';
import assert from 'node:assert';
import { createRpcBackend } from '../../src/rpc/client.js';

// The page's end of the protocol, over a transport that is two arrays: what it posted, and a
// hand that delivers the reader's messages and the other end going away. The served round trips
// are test/web/reader.test.ts's; this is what the client does on its own.
function wired(doc: string | null = 'd1') {
  const posted: any[] = [];
  let deliver: (m: any) => void = () => {};
  let hangUp: (why?: string) => void = () => {};
  const rpc = createRpcBackend({
    docId: () => doc,
    post: (m) => posted.push(m),
    onMessage: (fn) => void (deliver = fn),
    onDisconnect: (fn) => void (hangUp = fn),
    host: { kind: 'test' },
  });
  const last = () => posted.at(-1);
  return { rpc, posted, last, deliver: (m: any) => deliver(m), hangUp: (w?: string) => hangUp(w) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('calls are answered by id, and an answer for no call is dropped', async () => {
  const w = wired();
  assert.deepStrictEqual(w.posted, [{ t: 'hello', doc: 'd1' }], 'it says which document first');
  const doc = w.rpc.doc('read');
  const fonts = w.rpc.fonts();
  assert.deepStrictEqual(w.posted.slice(1), [
    { t: 'call', id: 1, m: 'doc', a: ['d1', 'read'] },
    { t: 'call', id: 2, m: 'fonts', a: [] },
  ], 'each call is numbered, with the document where the reader takes one');
  w.deliver({ t: 'ret', id: 2, v: {} });
  w.deliver({ t: 'ret', id: 99, v: 'stray' });
  w.deliver(null);
  w.deliver({ t: 'err', id: 1, e: { name: 'Closed', message: 'gone' } });
  assert.deepStrictEqual(await fonts, [], 'answers arrive out of order, to their own call');
  await assert.rejects(doc, (e: Error) => e.name === 'Closed', 'and an error keeps its name');
});

test('the other end going away rejects what waits, and says the watch is down', async () => {
  const w = wired();
  const live: unknown[][] = [];
  w.rpc.watch({ onEvent: () => {}, onLive: (...a) => live.push(a) });
  const waiting = w.rpc.markRead(null);
  w.hangUp();
  await assert.rejects(waiting, /the reader went away/, 'a call in flight is told why');
  await tick();
  assert.deepStrictEqual(live.at(-1), [false, 'Not watching the file — the reader went away'],
    'and the watch says so, once, for the page to show');
  const posted = w.posted.length;
  // Raced against a tick, so that a call left waiting on a reader that is gone fails here
  // rather than hanging the run.
  const late = Promise.race([w.rpc.prune('a', 'read'), tick().then(() => 'still waiting')]);
  await assert.rejects(late, /the reader went away/, 'a call after it fails at once');
  assert.strictEqual(w.posted.length, posted, 'without posting into nothing');

  const named = wired();
  const p = named.rpc.fonts();
  named.hangUp('The window closed');
  await assert.rejects(p, /The window closed/, 'a transport that knows why says so');
});

test('the watch: live once subscribed, events and drops, closed, stopped', async () => {
  const w = wired();
  const events: unknown[] = [];
  const live: unknown[][] = [];
  const stop = w.rpc.watch({ onEvent: (e) => events.push(e), onLive: (...a) => live.push(a) });
  w.deliver({ t: 'ret', id: w.last().id, v: null });
  await tick();
  assert.deepStrictEqual(live, [[true]], 'live once the reader says it is subscribed');
  w.deliver({ t: 'ev', e: { type: 'change' } });
  w.deliver({ t: 'live', on: false, why: 'unreadable', needs: 'grant' });
  assert.deepStrictEqual(events, [{ type: 'change' }], 'events are handed on');
  assert.deepStrictEqual(live[1], [false, 'unreadable', 'grant'], 'and so is the reader\'s drop');
  stop();
  assert.deepStrictEqual(w.last(), { t: 'call', id: 2, m: 'unwatch', a: [] }, 'stopping unwatches');
  stop();
  assert.strictEqual(w.last().id, 2, 'once');
  w.deliver({ t: 'ev', e: { type: 'late' } });
  assert.strictEqual(events.length, 1, 'and nothing is heard after');

  const c = wired();
  const said: unknown[][] = [];
  c.rpc.watch({ onEvent: () => {}, onLive: (...a) => said.push(a) });
  c.deliver({ t: 'err', id: 1, e: { name: 'Closed', message: 'x' } });
  await tick();
  assert.deepStrictEqual(said, [[false, 'That document is no longer open']],
    'a document since closed is a watch that is not live, said as the other backends say it');

  // A second watch replaces the first: the first's late answer must not speak for it.
  const r = wired();
  const first: unknown[][] = [];
  r.rpc.watch({ onEvent: () => {}, onLive: (...a) => first.push(a) });
  r.rpc.watch({ onEvent: () => {}, onLive: () => {} });
  r.deliver({ t: 'ret', id: 1, v: null });
  await tick();
  assert.deepStrictEqual(first, [], 'a watch replaced hears nothing');
});

test('commands from the host, and saying goodbye', () => {
  const w = wired(null);
  assert.deepStrictEqual(w.posted[0], { t: 'hello', doc: null }, 'a page with no document says so');
  const heard: string[] = [];
  const off = w.rpc.onCommand((n) => heard.push(n));
  w.rpc.onCommand((n) => heard.push(`also ${n}`));
  w.deliver({ t: 'command', name: 'find' });
  off();
  w.deliver({ t: 'command', name: 'print' });
  assert.deepStrictEqual(heard, ['find', 'also find', 'also print'],
    'every listener hears a command, until it stops listening');
  w.rpc.bye();
  assert.deepStrictEqual(w.last(), { t: 'bye' }, 'and going away is said');
  assert.deepStrictEqual(w.rpc.host, { kind: 'test' }, 'the host describes itself');
});
