// Serve the web app the way a static host will.
//
//   npm run webapp                    # builds, then http://127.0.0.1:8081/
//   npm run webapp -- -p 4000 --no-open
//
// `prewebapp` runs build:web and build:webapp first, so there is one command rather than two and
// no step to forget: an unstaged dist/web/ is a page with no reader.
//
// It has to be served rather than opened. The page is a module, and the reader is a
// SharedWorker: every browser refuses both from `file://`. And it has to be served from
// somewhere File System Access will agree to run, which is a secure context -- `localhost` and
// `127.0.0.1` count as one, so this works without a certificate.
//
// It answers with the headers in `_headers`, which is the whole of what this does that
// serve-site.mjs does not. A policy that only the deployed copy has is a policy nobody has run:
// the first sign of a directive that blocks the worker would be on the real site.
//
// The port is not walked past when it is taken, unlike the landing page's. IndexedDB and the
// folders a user has granted belong to an origin, and `127.0.0.1:8082` is another one: a server
// that quietly moved there would open an app with no history in it, and that looks exactly like
// the history being lost. Pick another with `-p` and it is a choice.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'dist', 'web');
const DEFAULT_PORT = 8081;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // Mermaid's chunks. A module script served as anything else is refused outright.
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The headers `_headers` puts on every path: the `/*` rule, which is the one build:webapp writes.
 * Read per request, because a rebuild while this runs changes the hash in the policy.
 */
function ruleHeaders(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, '_headers'), 'utf8');
  } catch {
    return {};
  }
  const headers = {};
  let inRule = false;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    // A path starts a rule, and what is indented under it belongs to it.
    if (!/^\s/.test(line)) inRule = line.trim() === '/*';
    else if (inRule) {
      const colon = line.indexOf(':');
      if (colon > 0) {
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    }
  }
  return headers;
}

/**
 * A static server over `root`, not yet listening.
 *
 * @param {string} root  The staged web app.
 * @returns {import('node:http').Server}
 */
export function createWebappServer(root) {
  return http.createServer((req, res) => {
    const send = (code, body, type = MIME['.txt']) => {
      // Nothing is cached, however briefly. A script held for a minute during a round of edits is
      // a change that looks like it did not land -- and a worker is the one thing the browser
      // already keeps alive on its own.
      res.writeHead(code, {
        ...ruleHeaders(root),
        'content-type': type,
        'cache-control': 'no-store',
      });
      res.end(body);
    };

    const url = new URL(req.url, 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.join(root, rel.endsWith('/') || rel === '' ? `${rel}index.html` : rel);

    // Whatever the path said, it has to land inside the app. This listens on the loopback only,
    // so the exposure is small, but a static server that will hand out ../../.ssh for the asking
    // is not a thing to leave lying in a repo.
    if (path.relative(root, file).startsWith('..')) return send(403, 'Forbidden');

    // Pages reads `_headers` and does not serve it, and neither does this.
    if (rel === '_headers' || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(404, `Not found: /${rel}`);
    }

    send(200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  });
}

function main() {
  const opts = { port: DEFAULT_PORT, open: true };

  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '-p' || a === '--port') opts.port = Number(process.argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else if (a === '--no-open') opts.open = false;
    else {
      console.error(`Unknown argument: ${a}\n\n  npm run webapp -- [-p <n>] [--no-open]`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    console.error('The port has to be a number between 0 and 65535.');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(WEB, 'index.html'))) {
    console.error('dist/web is not built — run npm run build:webapp (npm run webapp does it).');
    process.exit(1);
  }

  const server = createWebappServer(WEB);
  server.once('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(
      `Port ${opts.port} is taken. Another port is another origin, with its own history and ` +
        `its own granted folders, so this does not pick one for you: npm run webapp -- -p <n>`,
    );
    process.exit(1);
  });
  server.listen(opts.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(`redline web   ${WEB}`);
    console.log(`              ${url}   (ctrl-c to stop)`);

    if (opts.open) {
      const cmd =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'start'
            : 'xdg-open';
      const p = spawn(cmd, [url], {
        stdio: 'ignore',
        detached: true,
        shell: process.platform === 'win32',
      });
      // A machine with no `open` to run is not a reason for the server to fall over.
      p.on('error', () => {});
      p.unref();
    }
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      server.close();
      process.exit(0);
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
