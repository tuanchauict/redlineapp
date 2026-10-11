// The reader's end of the protocol: answer a page's calls from a session.
//
// Transport-blind. The host hands over how to send a message (`post`) and how to hear one
// (`onMessage`), and this does the rest -- which is little, because the session already decided
// what every call means.
import type { Session } from '../contract/seam.js';
import { SESSION_METHODS, encodeError } from './protocol.js';
import type { PageMessage, ReaderMessage, SessionMethod } from './protocol.js';

export interface ServeOptions {
  /** From `createSession` (src/reader/session.js). */
  session: Session;
  /** Send a message to the page. */
  post: (msg: ReaderMessage) => void;
  /** Hear the page's messages. May return the function that stops listening. */
  onMessage: (handler: (msg: PageMessage) => void) => (() => void) | void;
  /**
   * Calls that belong to the host and not to the reader (prefs, opening a link, granting a
   * folder). Tried first, so a host can answer a name before the session sees it.
   */
  extra?: Record<string, (...args: any[]) => any>;
  /** Told which document the page says it is showing. */
  onHello?: (doc: string | null) => void;
  /**
   * Told the page is going away (a tab closing, a page going into the back/forward cache). The
   * watch is already stopped by then. A host that holds a document for the page -- a worker that
   * retained it on `hello` -- lets go of it here; a transport that simply closes has no use for it.
   */
  onBye?: () => void;
}

/** Returns `close`: stop watching and stop listening. */
export function serveRpc({
  session,
  post,
  onMessage,
  extra = {},
  onHello,
  onBye,
}: ServeOptions): () => void {
  let off: (() => void) | null = null; // this connection's one watch
  const unwatch = () => {
    off?.();
    off = null;
  };

  const run = (m: string, a: unknown[]) => {
    if (Object.hasOwn(extra, m)) return extra[m](...a);
    if (m === 'watch') {
      unwatch();
      off = session.watch(a[0] as string | null, (e) => post({ t: 'ev', e }));
      return true;
    }
    if (m === 'unwatch') return unwatch();
    if ((SESSION_METHODS as readonly string[]).includes(m)) {
      return session[m as SessionMethod](...(a as [any, any, any]));
    }
    throw new Error(`no such method: ${m}`);
  };

  const hear = (msg: PageMessage) => {
    switch (msg?.t) {
      case 'hello':
        return onHello?.(msg.doc ?? null);
      case 'bye':
        // After the watch, not before: whatever `onBye` lets go of must not still be sending.
        unwatch();
        return onBye?.();
      case 'call':
        // Through a promise, so a method that throws synchronously and one that rejects are
        // answered the same way, and a page is never left waiting on a call that went wrong.
        return Promise.resolve()
          .then(() => run(msg.m, Array.isArray(msg.a) ? msg.a : []))
          .then(
            (v) => post({ t: 'ret', id: msg.id, v: v ?? null }),
            (err) => post({ t: 'err', id: msg.id, e: encodeError(err) }),
          );
    }
  };

  const stop = onMessage(hear);
  return () => {
    unwatch();
    if (typeof stop === 'function') stop();
  };
}
