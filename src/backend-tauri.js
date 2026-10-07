// The reader, in the page.
//
// This is the desktop half of the seam public/backend.js describes. There is no
// server here and nothing to reach over a socket: the reader is an object in
// the same JavaScript heap as the page that is asking, and every method below
// is a call rather than a request.
//
// Which is the point of the whole exercise. The browser build talks to
// src/server.js and the desktop build talks to this, and both are the same
// reader (src/reader.js) over the same store (src/store.js) -- the only thing
// that differs is how the page reaches it and which platform is underneath.
// Two implementations of the diff would be two products.
//
// Bundled to public/vendor/backend-tauri.js by scripts/build-web.mjs, and
// loaded only when the shell has left its facts on the window, so a browser tab
// never downloads a line of it.
import { createReader } from './reader.js';
import { DocStore } from './store.js';
import { installNative } from './native-tauri.js';
import { tauriPlatform } from './platform-tauri.js';

/**
 * Open what the window was given and answer the page's questions about it.
 *
 * @param {object} opts
 * @param {() => string|null} opts.docId  The document being shown, read per call.
 */
export async function createTauriBackend({ docId }) {
  const host = globalThis.__REDLINE_HOST ?? {};
  const reader = await createReader({ platform: tauriPlatform });

  // The window's own half of the shell, installed before the page looks for it.
  // It is also who holds this window's documents open, so the initial set goes
  // through it rather than straight to the reader -- one owner for the
  // bookkeeping, whether a tab arrived at launch or an hour later.
  const native = installNative({ reader });

  // The active document first: the page has no id to ask by on its first load,
  // and the reader reads "no id" as "the one you opened first".
  const files = [host.active, ...(host.files ?? [])].filter(
    (p, i, all) => p && all.indexOf(p) === i,
  );
  await native.sync(files);

  // Sweep snapshots no document refers to any more. Only the window the shell
  // marked, and only once a launch: two of these running at the same moment
  // could list the objects between another window writing a snapshot and
  // recording it, and take the new one away again.
  if (host.gc) DocStore.gc(tauriPlatform);

  // The same methods public/backend.js builds out of URLs, and in the same
  // shapes -- `ack` answering with the list, `prune` answering with the
  // document -- because the page is written against one surface and this is
  // the other implementation of it.
  return {
    doc: (baseline) => reader.doc(docId(), baseline),
    markRead: () => reader.markRead(docId()),
    ack: (opts) => reader.ack(docId(), opts),
    prune: (upto, baseline) => reader.prune(docId(), upto, baseline),
    plantumlSvg: (code) => reader.plantumlSvg(code),
    fonts: () => reader.fonts(),

    /**
     * Follow the document until the returned function is called.
     *
     * Live from the moment it is asked for, and it stays that way: there is no
     * connection to lose, so the "not watching right now" the http backend has
     * to be ready for cannot happen here. What can happen is being asked to
     * follow a document that has just been closed, which is the same race and
     * is reported the same way.
     */
    watch({ onEvent, onLive }) {
      const resolved = reader.idOf(docId());
      if (!resolved) {
        onLive(false, 'That document is no longer open');
        return () => {};
      }
      onLive(true);
      return reader.subscribe(resolved, onEvent);
    },
  };
}
