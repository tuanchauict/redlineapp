// The reader's surface in the form a page asks for it.
//
// The reader (./reader.js) is the one back end, and what it takes is not quite what a page
// sends: a page names a document by an id that may be stale, spells "on" as a string, leaves a
// baseline blank to mean "whatever I last had", and can send a diagram of any length. Those
// decisions used to be made in the routes of the node server, which made them an http thing.
// They are made here instead, once, so that a page behind a MessageChannel, a webview's
// postMessage or a socket is answered exactly as one behind http is -- the transports differ
// in how a call arrives and nothing else.
//
// A transport turns what this throws into its own language: `Closed` is a 410, `BadRequest` a
// 400, and everything else a fault.
import { Closed } from './reader.js';

/**
 * Cap on a single PlantUML fence, well past any real diagram. Exported because a transport
 * that streams its body (http) wants to stop reading at it, rather than buffer the lot to be
 * told no.
 */
export const MAX_DIAGRAM_SOURCE = 256 * 1024;

/** A call that is wrong in itself, whatever the document: nothing to retry, nothing to fix here. */
export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequest';
  }
}

/**
 * @param {Awaited<ReturnType<typeof import('./reader.js').createReader>>} reader
 */
export function createSession(reader) {
  return {
    /** The document, built against `baseline`; blank means whichever it was last compared to. */
    doc: (id, baseline) => reader.doc(id, baseline || 'last:read'),

    markRead: (id) => reader.markRead(id),

    /**
     * Check one change off or back on, or uncheck all of them. Answers `{ acked }`: the list of
     * checked keys, which is all a check-off changes.
     */
    async ack(id, { key, on = true, clear = false, at, block } = {}) {
      if (!key && !clear) throw new BadRequest('no change named');
      return { acked: await reader.ack(id, { key, on, clear: !!clear, at, block }) };
    },

    /**
     * Show a different file in this page. Answers with the id the page is on now, which is not
     * the one it asked with: opening releases the document the page was on.
     */
    async open(id, path) {
      if (!path) throw new BadRequest('no file named');
      // Resolved before the switch: `idOf` answers "whichever document you were started on"
      // for a page that never named one, and after the switch that answer would be the new
      // file releasing itself.
      const from = reader.idOf(id) || undefined;
      const opened = await reader.setFile(path, from);
      return { id: opened.id, path: opened.abs };
    },

    prune: (id, upto, baseline) => reader.prune(id, upto, baseline || 'last:read'),

    /**
     * One PlantUML fence, by source. Not about any document: the same diagram in two files is
     * the same diagram.
     */
    async plantumlSvg(code) {
      if (typeof code !== 'string' || !code.trim()) throw new BadRequest('no diagram source');
      if (code.length > MAX_DIAGRAM_SOURCE) throw new BadRequest('diagram source is too long');
      return reader.plantumlSvg(code);
    },

    /** The typefaces this host can list, for the settings sheet. */
    async fonts() {
      return { fonts: await reader.fonts() };
    },

    /**
     * Follow a document's changes until the returned function is called.
     *
     * Throws `Closed` when there is no such document. Resolved now rather than per event, and
     * to the document's own id rather than whatever the caller sent: a page that named nothing
     * still has to follow its document across a file switch.
     */
    watch(id, onEvent) {
      const resolved = reader.idOf(id);
      if (!resolved) throw new Closed();
      return reader.subscribe(resolved, onEvent);
    },
  };
}
