// The page's end of the protocol: the seam's shape, over messages.
//
// What public/backend.js builds out of URLs and the Tauri backend builds out of direct calls,
// this builds out of `post` and `onMessage`. The page is written against one surface, and this
// is the third implementation of it -- the payloads are the reader's own, untouched.
import { decodeError } from './protocol.js';

/**
 * @param {object} opts
 * @param {() => string|null} opts.docId  The document being shown, read per call.
 * @param {(msg: object) => void} opts.post  Send a message to the reader.
 * @param {(handler: (msg: object) => void) => (() => void) | void} opts.onMessage
 * @param {(handler: (why: string) => void) => void} [opts.onDisconnect]
 *   Told when the other end has gone. Every call still waiting is rejected, and the watch says
 *   it is no longer live.
 * @param {object} opts.host  What this host is, for the page to branch on.
 */
export function createRpcBackend({ docId, post, onMessage, onDisconnect, host }) {
  let next = 1;
  const pending = new Map(); // id -> { resolve, reject }
  let watcher = null; // { onEvent, onLive }
  const commands = new Set();
  let gone = null;

  const call = (m, ...a) =>
    new Promise((resolve, reject) => {
      if (gone) return reject(new Error(gone));
      const id = next++;
      pending.set(id, { resolve, reject });
      post({ t: 'call', id, m, a });
    });

  onMessage((msg) => {
    switch (msg?.t) {
      case 'ret':
      case 'err': {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.t === 'ret') p.resolve(msg.v);
        else p.reject(decodeError(msg.e));
        return;
      }
      case 'ev':
        return watcher?.onEvent(msg.e);
      case 'live':
        return watcher?.onLive(msg.on, msg.why, msg.needs);
      case 'command':
        for (const fn of commands) fn(msg.name);
    }
  });

  onDisconnect?.((why = 'Not watching the file — the reader went away') => {
    gone = why;
    for (const p of pending.values()) p.reject(new Error(why));
    pending.clear();
    watcher?.onLive(false, why);
  });

  post({ t: 'hello', doc: docId() });

  return {
    host,

    doc: (baseline) => call('doc', docId(), baseline),
    markRead: () => call('markRead', docId()),
    ack: (opts) => call('ack', docId(), opts).then((r) => r.acked ?? []),
    open: (path) => call('open', docId(), path),
    prune: (upto, baseline) => call('prune', docId(), upto, baseline),
    plantumlSvg: (code) => call('plantumlSvg', code),
    fonts: () => call('fonts').then((r) => r.fonts ?? []),

    /**
     * Follow the document until the returned function is called. Live once the reader says it is
     * subscribed; and a document that has since closed is reported the way the other backends
     * report it, as a watch that is not live.
     */
    watch({ onEvent, onLive }) {
      const mine = (watcher = { onEvent, onLive });
      call('watch', docId()).then(
        () => watcher === mine && onLive(true),
        (err) =>
          watcher === mine &&
          onLive(false, err.name === 'Closed' ? 'That document is no longer open' : err.message),
      );
      return () => {
        if (watcher !== mine) return;
        watcher = null;
        call('unwatch').catch(() => {});
      };
    },

    /** Hear a command the host started. Returns the function that stops listening. */
    onCommand(fn) {
      commands.add(fn);
      return () => commands.delete(fn);
    },

    /**
     * A call the host answers itself -- `serveRpc`'s `extra`. The surface above is the reader's;
     * what a host adds to it (taking a folder, say) is reached through here by its wrapper, and
     * never by the page, which is written against the surface alone.
     */
    call,

    /** Tell the reader this page is going away. */
    bye: () => post({ t: 'bye' }),
  };
}
