// The shapes the reader produces and every page consumes, written down once.
//
// Types only, and kept that way by a test (test-smoke.ts, "layering"): any layer may import this,
// including the ones that may import almost nothing, and importing it adds nothing to a bundle.
// What the payload *means* is in docs/architecture.md and docs/changes.md; this is its shape,
// which `buildDoc` in src/reader/reader.ts is checked against.

/** What this host can do at all, as opposed to `tracked`, which is about one file. */
export interface Caps {
  git: boolean;
  plantuml: boolean;
}

/** The commit a version came from, when git is where the history found it. */
export interface GitRef {
  sha: string;
  subject: string;
}

/**
 * One version in the history list. `current` and `baseline` say how it relates to the file; the
 * rest is the version itself.
 */
export interface HistoryRow {
  hash: string;
  ts: number;
  size: number | null;
  /** Bytes against the version before it, or null when either size is not known. */
  delta: number | null;
  current: boolean;
  baseline: boolean;
  git: GitRef | null;
}

/** A version that check-offs were made in, with the blocks checked in it. */
export interface AckedVersion {
  hash: string;
  text: string;
  blocks: string[];
}

/** The document as the reader sends it. The page renders it; the reader never does. */
export interface DocPayload {
  id: string;
  path: string;
  name: string;
  dir: string;
  dirLabel: string;
  pathLabel: string;
  hash: string;
  mtime: number | null;
  text: string;
  /** Null when there is nothing to compare against, which is not the same as an empty baseline. */
  base: string | null;
  acked: string[];
  ackedFrom: AckedVersion[];
  /** Which comparison was honoured: `read`, `none`, `git:HEAD` or `snap:<hash>`. */
  baseline: string;
  baselineAvailable: boolean;
  history: HistoryRow[];
  tracked: boolean;
  caps: Caps;
}

/** `prune`'s answer: the document rebuilt, and how many versions went. */
export type PrunedPayload = DocPayload & { removed: number };

/**
 * What a reader tells whoever is watching a document. `hash` is the version on disk; a host that
 * only wants the page to look again (a tab woken from the back/forward cache, a document taken
 * back after a sweep) sends `change` without one, and the page does not read it.
 */
export type ReaderEvent =
  | { type: 'change'; hash?: string }
  | { type: 'history' }
  | { type: 'file'; path: string }
  | { type: 'unreadable'; name: string; why: string }
  | { type: 'readable' };

/** One PlantUML fence, drawn or refused. */
export type PlantumlResult = { svg: string } | { error: string };
