// The page's end of the protocol: the seam's shape, over messages.
//
// What public/backend.js builds out of URLs and the Tauri backend builds out of direct calls,
// this builds out of `post` and `onMessage`. The page is written against one surface, and this
// is the third implementation of it -- the payloads are the reader's own, untouched.
import type { Backend, WatchHandlers } from '../contract/seam.js';
import type { DocPayload, PlantumlResult, PrunedPayload } from '../contract/payload.js';
import { decodeError } from './protocol.js';
import type { PageMessage, ReaderMessage } from './protocol.js';

/** What a host says about itself for the page to branch on. Each host's literal is its own. */
export type HostInfo = Record<string, unknown>;

export interface RpcBackendOptions {
  /** The document being shown, read per call. */
  docId: () => string | null;
  /** Send a message to the reader. */
  post: (msg: PageMessage) => void;
  /** Hear the reader's messages. May return the function that stops listening. */
  onMessage: (handler: (msg: ReaderMessage) => void) => (() => void) | void;
  /**
   * Told when the other end has gone. Every call still waiting is rejected, and the watch says
   * it is no longer live.
   */
  onDisconnect?: (handler: (why?: string) => void) => void;
  /** What this host is, for the page to branch on. */
  host: HostInfo;
}

/**
 * The page's `Backend`, plus what only a message transport has: the host's description, the
 * generic `call` that a host's wrapper reaches its own methods through, and the command channel.
 * `open` is always here, though the `Backend` it extends leaves it out for the desktop app.
 */
export interface RpcBackend extends Backend {
  host: HostInfo;
  open: NonNullable<Backend['open']>;
  call<T = unknown>(m: string, ...a: unknown[]): Promise<T>;
  /** Hear a command the host started. Returns the function that stops listening. */
  onCommand(fn: (name: string) => void): () => void;
  /** Tell the reader this page is going away. */
  bye(): void;
}

export function createRpcBackend({
  docId,
  post,
  onMessage,
  onDisconnect,
  host,
}: RpcBackendOptions): RpcBackend {
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let watcher: WatchHandlers | null = null;
  const commands = new Set<(name: string) => void>();
  let gone: string | null = null;

  // The wire carries whatever the reader answered, so what a call returns is the caller's to say.
  const call = <T = unknown>(m: string, ...a: unknown[]): Promise<T> =>
    new Promise((resolve, reject) => {
      if (gone) return reject(new Error(gone));
      const id = next++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
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

    doc: (baseline) => call<DocPayload>('doc', docId(), baseline),
    markRead: (at) => call<DocPayload>('markRead', docId(), at),
    ack: (opts) => call<{ acked?: string[] }>('ack', docId(), opts).then((r) => r.acked ?? []),
    open: (path) => call<{ id: string; path: string }>('open', docId(), path),
    prune: (upto, baseline) => call<PrunedPayload>('prune', docId(), upto, baseline),
    plantumlSvg: (code) => call<PlantumlResult>('plantumlSvg', code),
    fonts: () => call<{ fonts?: string[] }>('fonts').then((r) => r.fonts ?? []),

    /**
     * Follow the document until the returned function is called. Live once the reader says it is
     * subscribed; and a document that has since closed is reported the way the other backends
     * report it, as a watch that is not live.
     */
    watch({ onEvent, onLive }) {
      const mine = (watcher = { onEvent, onLive });
      call('watch', docId()).then(
        () => watcher === mine && onLive(true),
        (err: Error) =>
          watcher === mine &&
          onLive(false, err.name === 'Closed' ? 'That document is no longer open' : err.message),
      );
      return () => {
        if (watcher !== mine) return;
        watcher = null;
        call('unwatch').catch(() => {});
      };
    },

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

    bye: () => post({ t: 'bye' }),
  };
}
