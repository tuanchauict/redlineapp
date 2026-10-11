// The two surfaces the page's front end is written against, and the one a transport serves.
//
// `Session` is the reader as a page may ask for it (src/reader/session.js): every call names a
// document by id. `Backend` is what the page holds: the same calls with the id taken out, because
// a page is on one document and the backend remembers which. There are three implementations of
// `Backend` -- public/backend.js over http, src/hosts/tauri/backend.js over direct calls and
// src/rpc/client.ts over messages -- and what is declared here is what they have to agree on.
import type { DocPayload, PlantumlResult, PrunedPayload, ReaderEvent } from './payload.js';

/** What `ack` takes. `key` names the change; `clear` brings every one back instead. */
export interface AckOptions {
  key?: string;
  on?: boolean;
  clear?: boolean;
  /** The version the page was showing when it clicked. */
  at?: string;
  /** The change's `block` from that render. */
  block?: string;
}

/**
 * Who to tell. `onLive(false)` says the watch is not running right now; `needs` is a host's hint
 * of what would fix it (`'permission'`), and absent from the ones that have no such thing.
 */
export interface WatchHandlers {
  onEvent(e: ReaderEvent): void;
  onLive(on: boolean, why?: string, needs?: string): void;
}

/** The reader as a transport serves it. Ids may be stale or null; the session resolves them. */
export interface Session {
  doc(id: string | null, baseline?: string): Promise<DocPayload>;
  markRead(id: string | null, at?: string): Promise<DocPayload>;
  /** Answers `{ acked }`, the checked keys, which is all a check-off changes. */
  ack(id: string | null, opts?: AckOptions): Promise<{ acked: string[] }>;
  open(id: string | null, path: string): Promise<{ id: string; path: string }>;
  prune(id: string | null, upto: string, baseline?: string): Promise<PrunedPayload>;
  plantumlSvg(code: string): Promise<PlantumlResult>;
  fonts(): Promise<{ fonts: string[] }>;
  /** Throws `Closed` when there is no such document. Returns the function that stops. */
  watch(id: string | null, onEvent: (e: ReaderEvent) => void): () => void;
}

/** What the page calls. The same document throughout, so no ids. */
export interface Backend {
  doc(baseline?: string): Promise<DocPayload>;
  markRead(at?: string): Promise<DocPayload>;
  /** The checked keys. The `{ acked }` wrapper is the session's and does not reach the page. */
  ack(opts: AckOptions): Promise<string[]>;
  /** Absent where the shell, not the page, opens files: the desktop app has tabs for that. */
  open?(path: string): Promise<{ id: string; path: string }>;
  prune(upto: string, baseline?: string): Promise<PrunedPayload>;
  plantumlSvg(code: string): Promise<PlantumlResult>;
  fonts(): Promise<string[]>;
  /** Follow the document until the returned function is called. */
  watch(handlers: WatchHandlers): () => void;
}
