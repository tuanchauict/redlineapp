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
//     { t: 'ping' }              the web host's keep-alive; its worker answers it before
//                                `serveRpc` is asked, and `serveRpc` would only ignore it
//
//   reader -> page
//     { t: 'ret', id, v }        the result of call `id`
//     { t: 'err', id, e }        call `id` failed; `e` is { name, message }, and a `rootId` when
//                                the error is about one of a host's roots
//     { t: 'ev', e }             a reader event (`ReaderEvent`, src/contract/payload.ts)
//     { t: 'live', on, why, needs }  what `onLive` would have said; `needs` is a host's hint of
//                                what would fix it ('permission'), and absent otherwise
//     { t: 'command', name }     a command the host started, such as a keybinding
//
// `watch` is an ordinary call: its `ret` means "subscribed", and `ev` messages follow. A
// connection has one page, so at most one watch; `unwatch` is a call too.
import type { ReaderEvent } from '../contract/payload.js';
import type { Session } from '../contract/seam.js';

/** page -> reader. */
export type PageMessage =
  | { t: 'hello'; doc: string | null }
  | { t: 'call'; id: number; m: string; a: unknown[] }
  | { t: 'bye' }
  | { t: 'ping' };

/** An error as it travels: its name and message, and a root when a host's error is about one. */
export interface WireError {
  name: string;
  message: string;
  rootId?: string;
}

/** reader -> page. */
export type ReaderMessage =
  | { t: 'ret'; id: number; v: unknown }
  | { t: 'err'; id: number; e: WireError }
  | { t: 'ev'; e: ReaderEvent }
  | { t: 'live'; on: boolean; why?: string; needs?: string }
  | { t: 'command'; name: string };

/** The session's methods a page may call. `watch` is the connection's own and is not one. */
export type SessionMethod = Exclude<keyof Session, 'watch'>;

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
] as const);

// A method added to `Session` and left out of the list above is a method no page can call, and a
// name in the list that `Session` does not have is a call that can only fail. Both are the drift
// this file exists to prevent, and neither is visible at runtime until a page asks.
type Assert<T extends true> = T;
type Listed = (typeof SESSION_METHODS)[number];
export type SessionMethodsAreListed = Assert<
  [SessionMethod] extends [Listed] ? ([Listed] extends [SessionMethod] ? true : false) : false
>;

/** An error as it travels: its name and what it said, and nothing that cannot be cloned. */
export const encodeError = (err: any): WireError => ({
  name: String(err?.name ?? 'Error'),
  message: String(err?.message ?? err),
  // Which root a host's error is about, when it says (the web's `NeedsPermission`). The only
  // field that goes beyond name and message, and absent -- not undefined -- when there is none.
  ...(typeof err?.rootId === 'string' && { rootId: err.rootId }),
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
export function decodeError({ name, message, rootId }: Partial<WireError> = {}): Error {
  if (name === 'Closed') return new Closed(message);
  const err: Error & { rootId?: string } = new Error(message);
  err.name = name || 'Error';
  if (rootId !== undefined) err.rootId = rootId;
  return err;
}
