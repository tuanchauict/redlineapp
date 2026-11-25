// One preview panel: a webview, the document it shows, and the conversation between them.
//
// Written against the parts of the editor's API it touches and against the reader, and not
// against the `vscode` module, so that the suite can drive a panel with a fake webview and the
// real reader and see what a page would be told. extension.ts is what makes the real ones.
import type * as vscode from 'vscode';

import type { Session } from '../../contract/seam.js';
import { serveRpc } from '../../rpc/serve.js';
import type { PageMessage } from '../../rpc/protocol.js';
import type { Reader } from '../../reader/reader.js';
import { webviewHtml } from './html.js';

/** The preferences the extension host keeps for every panel, as `host.js` is seeded with them. */
export interface PrefsStore {
  all(): Record<string, string>;
  /** `null` removes it. */
  set(key: string, value: string | null): void;
}

/** What `host.js` posts when the page changes a preference. */
interface PrefMessage {
  t: 'pref';
  k: string;
  v: string | null;
}

export interface PanelDeps {
  panel: Pick<vscode.WebviewPanel, 'webview' | 'title' | 'onDidDispose'>;
  reader: Pick<Reader, 'retain' | 'release'>;
  session: Session;
  /** The staged `index.html` and where the page's directory is served from. */
  page: { html: string; base: string };
  prefs: PrefsStore;
  dark: () => boolean;
  /** The panel's title for a file; the file's name, unless the extension says otherwise. */
  title?: (path: string) => string;
}

export interface Panel {
  /** The document the panel is on. Changes when a link in it is followed. */
  readonly path: string;
  /** Tell the page the editor's theme moved. */
  setDark(dark: boolean): void;
  dispose(): void;
}

const nameOf = (p: string): string => p.split(/[/\\]/).filter(Boolean).at(-1) ?? p;

/**
 * Every call a page makes is about *this* panel's document, whatever id it says. A page has no
 * way to learn which document is its own other than asking with none and being told, and the
 * reader answers "none" with whichever document was opened first -- right in a window of one,
 * and in a second panel somebody else's file. So the id is taken from the panel, and the page's
 * is ignored; opening another file moves the panel's, so that the ones after it follow.
 */
function pinned(
  session: Session,
  id: () => string,
  moved: (to: { id: string; path: string }) => void,
): Session {
  return {
    doc: (_id, baseline, to) => session.doc(id(), baseline, to),
    markRead: (_id, at) => session.markRead(id(), at),
    ack: (_id, opts) => session.ack(id(), opts),
    async open(_id, path) {
      const to = await session.open(id(), path);
      moved(to);
      return to;
    },
    restore: (_id, hash, baseline) => session.restore(id(), hash, baseline),
    prune: (_id, upto, baseline) => session.prune(id(), upto, baseline),
    plantumlSvg: (code) => session.plantumlSvg(code),
    fonts: () => session.fonts(),
    watch: (_id, onEvent) => session.watch(id(), onEvent),
  };
}

/**
 * Open `path` in `panel`. Rejects, before touching the panel, when the file cannot be read: the
 * caller still owns a panel with nothing in it, and says why.
 */
export async function attachPanel(deps: PanelDeps, path: string): Promise<Panel> {
  const { panel, reader, session, page, prefs } = deps;
  const title = deps.title ?? nameOf;
  let id = await reader.retain(path);
  let current = path;
  let closed = false;

  panel.title = title(path);
  panel.webview.html = webviewHtml({
    html: page.html,
    base: page.base,
    cspSource: panel.webview.cspSource,
    prefs: prefs.all(),
    dark: deps.dark(),
    path,
  });

  const stop = serveRpc({
    session: pinned(
      session,
      () => id,
      (to) => {
        id = to.id;
        current = to.path;
        panel.title = title(to.path);
      },
    ),
    post: (msg) => void panel.webview.postMessage(msg),
    onMessage(handler) {
      const sub = panel.webview.onDidReceiveMessage((msg: PageMessage | PrefMessage) => {
        // The page's preference writes are not the reader's business, and are answered here.
        if (msg?.t === 'pref') {
          if (typeof msg.k === 'string' && (msg.v === null || typeof msg.v === 'string')) {
            prefs.set(msg.k, msg.v);
          }
          return;
        }
        handler(msg as PageMessage);
      });
      return () => sub.dispose();
    },
  });

  const dispose = () => {
    if (closed) return;
    closed = true;
    stop();
    reader.release(id);
  };
  panel.onDidDispose(dispose);

  return {
    get path() {
      return current;
    },
    setDark: (dark) => void panel.webview.postMessage({ t: 'scheme', dark }),
    dispose,
  };
}
