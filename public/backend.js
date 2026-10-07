// What the page needs from whatever is behind it.
//
// Two things can be behind it. In the CLI there is an http server (src/server.js)
// and the page reaches it over fetch and an event stream. In the desktop app
// there is no server and nothing to reach: the reader (src/reader.js) is in the
// page already, holding the store and the file watch directly. This module is
// the seam between those two, so that everything above it -- the whole of
// app.js -- is written once, and neither host gets its own copy of what marking
// a document read does to the screen.
//
// The shape follows the reader's own surface, because the reader is what sits
// on the far side in both cases. The one deliberate difference is the document
// id. The reader takes it per call; here it is a function handed in once,
// because a page shows exactly one document and the id it goes by is not the
// page's to decide -- it is assigned by whatever is behind this the first time
// it answers, and it changes again when a shell opens a different file into
// this same window. Reading it per call is what keeps a reconnect after such a
// switch pointed at the document the reader still has open.

/** How long to wait before trying the event stream again. */
const RETRY_MS = 1500;

/**
 * Whichever of the two the page turns out to be running in.
 *
 * The shell leaves its facts on the window before the page runs, so this is
 * settled by the time anyone asks -- there is nothing to try and fall back
 * from. The reader arrives through a dynamic import so that a browser tab never
 * downloads it; asking is a promise either way because one of the two answers
 * is a module that has to be fetched first.
 *
 * @param {object} opts
 * @param {() => string|null} opts.docId  The document being shown, read per call.
 */
export async function createBackend({ docId }) {
  if (globalThis.__REDLINE_HOST) {
    const { createTauriBackend } = await import('./vendor/backend-tauri.js');
    return createTauriBackend({ docId });
  }
  return httpBackend({ docId });
}

/**
 * Talk to the server the page was loaded from.
 *
 * @param {object} opts
 * @param {() => string|null} opts.docId  The document being shown, read per call.
 */
function httpBackend({ docId }) {
  const url = (path, params = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null) q.set(k, v);
    // Absent rather than empty when the page has not been told an id yet: the
    // server reads "no id" as "whichever document you were started on", which
    // is the whole of how a browser tab gets its first document.
    const id = docId();
    if (id) q.set('id', id);
    return `${path}?${q}`;
  };

  /**
   * The JSON answer, or a throw saying why there is none.
   *
   * A document that has closed is this request losing a race with a window
   * shutting, and a fault is a fault; either way what came back is not a
   * document, and adopting it as one would fail later, somewhere further from
   * the cause than here.
   */
  const json = async (res) => {
    if (res.ok) return res.json();
    const said = await res.json().catch(() => null);
    throw new Error(said?.error || `request failed (${res.status})`);
  };

  const get = (path, params) => fetch(url(path, params)).then(json);
  const post = (path, params, body) =>
    fetch(url(path, params), { method: 'POST', body }).then(json);

  return {
    /** The document, built against `baseline`. */
    doc: (baseline) => get('/api/doc', { baseline }),

    /** Move the read mark to what is on disk. Answers with the document. */
    markRead: () => post('/api/mark-read'),

    /**
     * Check or uncheck one change, or uncheck all of them. Answers with the
     * checked keys. `at` and `block` say what the change was when it was
     * checked; see `reader.ack`.
     */
    ack: ({ key, on = true, clear = false, at, block } = {}) =>
      post('/api/ack', clear ? { clear: '1' } : { key, on: on ? '1' : '0', at, block }).then(
        (r) => r.acked ?? [],
      ),

    /**
     * Show a different file in this page. Answers with `{ id }` — the document
     * this page is now on, which is not the one it asked with.
     *
     * Only the browser has this. The desktop app never switches a window's
     * file from the page: a link to another document opens a window for it,
     * and the shell does that through its own command.
     */
    open: (path) => post('/api/open', { path }),

    /** Forget `upto` and everything older. Answers with the document that is left. */
    prune: (upto, baseline) => post('/api/prune', { upto, baseline }),

    /** One PlantUML fence, by source: `{ svg }` or `{ error }`. */
    plantumlSvg: (code) => post('/api/plantuml', {}, code),

    /** The font families installed where the server runs, sorted. */
    fonts: () => get('/api/fonts').then((r) => r.fonts ?? []),

    /**
     * Follow the document until the returned function is called.
     *
     * Staying connected is this side's problem, not the page's: a dropped
     * socket is a fact about http and means nothing to a reader held in the
     * page, so the retry and the words for "not watching right now" both live
     * here. `onLive(false, why)` is the only one with anything to say, because
     * a watch that is working has nothing to report.
     */
    watch({ onEvent, onLive }) {
      let stream = null;
      let timer = null;
      let stopped = false;

      const connect = () => {
        if (stopped) return;
        const es = (stream = new EventSource(url('/events')));
        es.onopen = () => onLive(true);
        es.onmessage = (e) => onEvent(JSON.parse(e.data));
        es.onerror = () => {
          onLive(false, 'Not watching the file — trying to reconnect');
          es.close();
          if (stream === es) timer = setTimeout(connect, RETRY_MS);
        };
      };
      connect();

      return () => {
        stopped = true;
        clearTimeout(timer);
        stream?.close();
      };
    },
  };
}
