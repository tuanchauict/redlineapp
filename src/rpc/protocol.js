// The messages between a page and the reader that serves it, for hosts where the two are not in
// one heap: a MessageChannel, a webview's postMessage, a Worker.
//
// Every message is structured-cloneable -- the payloads are plain JSON already -- so a host may
// carry it however it likes. Nothing here knows how, and nothing here imports the reader: the
// page side of this protocol is bundled into a page, which has no business with the other side.
//
//   page -> reader
//     { t: 'hello', doc }        this page shows `doc`; null means whichever was opened first
//     { t: 'call', id, m, a }    call method `m` with the argument array `a`
//     { t: 'bye' }               the page is going away
//
//   reader -> page
//     { t: 'ret', id, v }        the result of call `id`
//     { t: 'err', id, e }        call `id` failed; `e` is { name, message }
//     { t: 'ev', e }             a reader event: change, file or history
//     { t: 'live', on, why }     what `onLive` would have said
//     { t: 'command', name }     a command the host started, such as a keybinding
//
// `watch` is an ordinary call: its `ret` means "subscribed", and `ev` messages follow. A
// connection has one page, so at most one watch; `unwatch` is a call too.

/**
 * The session's methods a page may call -- listed, not looked up, so that a message cannot name
 * `constructor` or anything else that happens to be on the object. `watch` and `unwatch` are
 * not here: they are the connection's own.
 */
export const SESSION_METHODS = Object.freeze([
  'doc',
  'markRead',
  'ack',
  'open',
  'prune',
  'plantumlSvg',
  'fonts',
]);

/** An error as it travels: its name and what it said, and nothing that cannot be cloned. */
export const encodeError = (err) => ({
  name: String(err?.name ?? 'Error'),
  message: String(err?.message ?? err),
});

/**
 * The reader's `Closed`, as the page sees it. It is a class of its own because this side cannot
 * import the reader's; what the two share is the name, which is what a caller tests for.
 */
export class Closed extends Error {
  constructor(message = 'document closed') {
    super(message);
    this.name = 'Closed';
  }
}

/** Turn a travelled error back into one, with the same `name` it was thrown with. */
export function decodeError({ name, message } = {}) {
  if (name === 'Closed') return new Closed(message);
  const err = new Error(message);
  err.name = name || 'Error';
  return err;
}
