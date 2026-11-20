// The VS Code extension's host shim: the first script in the page, a classic script rather than a
// module so that it runs before the head script in index.html and before app.js.
//
// It says three things the page cannot find out for itself:
//
//   - that there is no server and no shell, and the reader is on the other side of
//     `postMessage` (`backend.js` reads the flag and loads `vendor/backend-vscode.js`)
//   - where preferences live. A webview's `localStorage` is not kept between sessions, and is not
//     shared between two panels, so the extension host keeps them in the editor's global state
//     and writes them into the page as a `<meta>` (html.ts). They are read here, synchronously,
//     because the head script reads them before first paint; and a change is posted back
//   - whether the editor is dark. `prefers-color-scheme` in a webview is the operating system's,
//     not the theme's, and "System" in Settings means what the page around it looks like. So the
//     one query the page asks is answered from the editor's theme instead, and a theme change
//     arrives as a message and is passed on to whoever is listening, as the browser would
//
// Not copied into `public/` -- the repository's own `public/host.js` stays the empty one, and the
// extension's build stages this file over it (`stage-page.mts`), so that a change here cannot
// reach the Mac app, the CLI or the web app.
globalThis.__REDLINE_VSCODE = true;

(() => {
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content;
  // `acquireVsCodeApi` may be called once per page. The backend finds the handle here.
  const api = acquireVsCodeApi();
  globalThis.__REDLINE_VSCODE_API = api;
  // What the serializer is handed back when the editor restores this panel after a restart: the
  // file, since the page itself is gone and the extension host has to reopen it.
  const path = meta('redline-path');
  if (path) api.setState({ path });

  let seed = {};
  try {
    seed = JSON.parse(meta('redline-prefs') || '{}');
  } catch {}
  const kept = new Map(Object.entries(seed));
  globalThis.__REDLINE_PREFS = {
    getItem: (k) => (kept.has(k) ? kept.get(k) : null),
    setItem(k, v) {
      kept.set(k, String(v));
      api.postMessage({ t: 'pref', k, v: String(v) });
    },
    removeItem(k) {
      kept.delete(k);
      api.postMessage({ t: 'pref', k, v: null });
    },
  };

  let dark = meta('redline-scheme') === 'dark';
  const listening = new Set();
  const realMatchMedia = globalThis.matchMedia.bind(globalThis);
  globalThis.matchMedia = (query) => {
    if (!/prefers-color-scheme:\s*dark/.test(query)) return realMatchMedia(query);
    return {
      media: query,
      get matches() {
        return dark;
      },
      onchange: null,
      addEventListener: (type, fn) => type === 'change' && listening.add(fn),
      removeEventListener: (type, fn) => type === 'change' && listening.delete(fn),
      addListener: (fn) => listening.add(fn),
      removeListener: (fn) => listening.delete(fn),
      dispatchEvent: () => true,
    };
  };
  addEventListener('message', (e) => {
    if (e.data?.t !== 'scheme' || !!e.data.dark === dark) return;
    dark = !!e.data.dark;
    for (const fn of listening) fn({ matches: dark, media: '(prefers-color-scheme: dark)' });
  });
})();
