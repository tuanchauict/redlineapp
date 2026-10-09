// The browser front door: an http server over a reader (src/reader/reader.js).
//
// Nothing but routing lives here. A browser tab needs a URL to talk to, and
// this is that URL — the reader itself has no opinion about http, because the
// desktop app holds it directly and never asks it over a socket.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { createReader, Closed } from '../../reader/reader.js';
import { nodePlatform } from './platform.js';
import { directives, inlineScriptHashes, serialize } from '../../core/csp.js';

// Cap on a single PlantUML fence, well past any real diagram.
const MAX_DIAGRAM_SOURCE = 256 * 1024;

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC = path.join(ROOT, 'public');

// The app icon doubles as the browser tab's favicon; it lives with the other
// icon sources rather than being copied into public/.
const ICON = path.join(ROOT, 'assets', 'icon.svg');

const VENDOR = {
  '/vendor/github-markdown.css': require.resolve('github-markdown-css/github-markdown.css'),
  '/vendor/hljs-light.css': require.resolve('highlight.js/styles/github.css'),
  '/vendor/hljs-dark.css': require.resolve('highlight.js/styles/github-dark.css'),
};

// Mermaid lazy-loads chunks relative to its own URL, so the whole dist tree is
// mounted rather than a single file.
const MERMAID_PREFIX = '/vendor/mermaid/';
const MERMAID_DIST = path.dirname(require.resolve('mermaid/dist/mermaid.esm.min.mjs'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * The page's content security policy, as a header on index.html.
 *
 * The document is sanitized before it reaches the DOM (src/page/sanitize.js); this
 * is the floor under that, so that a document which got something past it
 * still could not run it. Script only from this server, plus the one inline
 * script in the head -- by hash, because it has to run before first paint and
 * so cannot be a file. Images from anywhere, because a README's badges and
 * screenshots are on the web and always have been. `connect-src 'self'` is
 * what keeps anything the page reads from being posted somewhere else.
 *
 * The Tauri build carries the same policy in shell/tauri.conf.json, where the
 * bundler works out the hash itself; the two are compared by the test suite.
 */
export function contentSecurityPolicy(html) {
  return serialize(directives({ 'script-src': ["'self'", ...inlineScriptHashes(html)] }));
}

/**
 * Whether a request came from this server's own page.
 *
 * The server binds 127.0.0.1, which keeps other machines out but not other web
 * pages: any site open in the same browser can send a request here. Two ways
 * in, two checks.
 *
 * A Host that is not this address is DNS rebinding -- a site that has pointed
 * its own name at 127.0.0.1, so that the browser thinks reading /api/doc is
 * same-origin. Every route is closed to that, the static ones included.
 *
 * A request from another origin is a blind write: it cannot read the answer,
 * but `/api/open` with any path would still have the reader snapshot that file
 * into the store. A browser says where a request came from in `Origin` and,
 * since 2023 everywhere, in `Sec-Fetch-Site`, so either one naming somewhere
 * else is refused. Neither is sent by curl or Node's fetch, which is what
 * keeps the test suite and a script on this machine working -- and something
 * already running here does not need this server to read a file.
 */
function fromOwnPage(req) {
  const port = req.socket.localPort;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && !hosts.some((h) => origin === `http://${h}`)) return false;
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

/**
 * Open `file` and serve it. What comes back is the reader, plus the server to
 * listen on — an embedder drives documents through the former and only needs
 * the latter to hand the page a URL.
 */
export async function createServer({ file, plantumlJar, platform = nodePlatform } = {}) {
  const reader = await createReader({ platform, plantumlJar });

  // The document the server was started on. A shell that opens its own windows
  // should release this once they hold their own references.
  const initialId = await reader.retain(file);

  const csp = contentSecurityPolicy(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    const param = (name) => url.searchParams.get(name);
    const post = req.method === 'POST';

    const send = (code, body, type = 'application/json', headers = {}) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (!fromOwnPage(req)) return send(403, { error: 'not from this page' });

    /**
     * Answer with whatever the reader says, once it has said it.
     *
     * Every one of these reaches the disk, so a request that goes wrong has to
     * be answered here rather than becoming an unhandled rejection that leaves
     * the page waiting on a socket nobody will ever write to. A document that
     * has closed is 410 and not 500: a window shutting while its page had a
     * request in flight is an ordinary race, not a fault.
     */
    const answer = (work) =>
      Promise.resolve()
        .then(work)
        .then(
          (body) => send(200, body),
          (err) =>
            err instanceof Closed
              ? send(410, { error: 'document closed' })
              : send(500, { error: String(err?.message || err) }),
        );

    // Render one PlantUML fence. The only endpoint here that is about no
    // particular document: the page asks by source, because that is all a
    // placeholder in the page knows about itself, and the same diagram in two
    // files is the same diagram.
    //
    // Answers 200 with `{ error }` rather than a failure status — a diagram
    // that would not draw is something to say in the page, next to where it
    // should have been, not a failed request for the page to guess about.
    if (url.pathname === '/api/plantuml' && post) {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        // A fence long enough to hit this is not a diagram, it is a mistake.
        if (body.length > MAX_DIAGRAM_SOURCE) req.destroy();
        else body += chunk;
      });
      req.on('end', () => {
        if (!body.trim()) return send(400, { error: 'no diagram source' });
        answer(() => reader.plantumlSvg(body));
      });
      return;
    }

    // The typefaces on this machine, for the settings sheet. The other
    // endpoint about no particular document: a browser cannot enumerate fonts,
    // so the one process that can is asked on the page's behalf.
    if (url.pathname === '/api/fonts') {
      return answer(async () => ({ fonts: await reader.fonts() }));
    }

    if (url.pathname === '/api/doc') {
      // No `baseline` means "open it": whatever it was last compared against,
      // and the read mark only if it never has been. See `reader.doc`.
      return answer(() => reader.doc(id, param('baseline') || 'last:read'));
    }
    if (url.pathname === '/api/mark-read' && post) {
      return answer(() => reader.markRead(id));
    }
    if (url.pathname === '/api/ack' && post) {
      const key = param('key');
      if (!key && !param('clear')) return send(400, { error: 'no change named' });
      return answer(async () => ({
        acked: await reader.ack(id, {
          key,
          on: param('on') !== '0',
          clear: !!param('clear'),
          at: param('at'),
          block: param('block'),
        }),
      }));
    }
    // Show a different file in this page. A link from one document to the one
    // beside it is the ordinary way to move through a set of notes, and a tab
    // has nowhere else to put it: the desktop app answers the same link with a
    // window of its own, which a browser tab has no way to ask for.
    //
    // The new id comes back because it is not the one that was sent — opening
    // releases the document this page was on, and the page has to be holding
    // the live id before it asks for anything else.
    if (url.pathname === '/api/open' && post) {
      const file = param('path');
      if (!file) return send(400, { error: 'no file named' });
      // Resolved before the switch: `lookup` answers "whichever document you
      // were started on" for a tab that never named one, and after the switch
      // that answer would be the new file releasing itself.
      const from = reader.idOf(id) || undefined;
      return answer(async () => {
        const opened = await reader.setFile(file, from);
        return { id: opened.id, path: opened.abs };
      });
    }
    if (url.pathname === '/api/prune' && post) {
      return answer(() => reader.prune(id, param('upto'), param('baseline') || 'last:read'));
    }

    // One document's changes, as they happen. The subscription is resolved
    // now rather than per event, so a listener that did not name a document
    // still follows that document across a switch.
    if (url.pathname === '/events') {
      // Resolved first, and to the document's own id rather than to the empty
      // string the caller may have sent: a listener that named no document
      // still has to follow that document across a switch.
      const resolved = reader.idOf(id);
      if (!resolved) return send(410, { error: 'document closed' });

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      const off = reader.subscribe(resolved, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        off();
      });
      return;
    }

    if (url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });

    // --- static assets -----------------------------------------------------

    if (VENDOR[url.pathname]) {
      return send(200, fs.readFileSync(VENDOR[url.pathname], 'utf8'), MIME['.css']);
    }

    if (url.pathname === '/icon.svg') {
      return send(200, fs.readFileSync(ICON, 'utf8'), MIME['.svg']);
    }

    if (url.pathname.startsWith(MERMAID_PREFIX)) {
      const asset = path.join(MERMAID_DIST, url.pathname.slice(MERMAID_PREFIX.length));
      if (!asset.startsWith(MERMAID_DIST + path.sep) || !fs.existsSync(asset)) {
        return send(404, 'not found', 'text/plain');
      }
      const type = MIME[path.extname(asset)] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=3600' });
      return res.end(fs.readFileSync(asset));
    }

    const name = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const filePath = path.join(PUBLIC, name);
    if (filePath.startsWith(PUBLIC) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const type = MIME[path.extname(filePath)] || 'text/plain';
      const headers = name === 'index.html' ? { 'content-security-policy': csp } : {};
      return send(200, fs.readFileSync(filePath, 'utf8'), type, headers);
    }
    send(404, 'not found', 'text/plain');
  });

  server.on('close', () => reader.closeAll());

  // The reader's own surface, plus the server. Spread rather than nested so
  // that an embedder holding this is holding the reader.
  return {
    ...reader,
    get abs() {
      return reader.abs;
    },
    server,
    initialId,
  };
}
