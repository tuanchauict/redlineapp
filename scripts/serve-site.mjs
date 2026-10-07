// Serve the landing page the way a browser will.
//
//   npm run site               # builds, then http://127.0.0.1:8080/
//   npm run site -- -p 4000 --no-open
//
// `presite` runs build:site first, so there is one command rather than two, and
// no step to forget: an unstaged site/ is the page with no icon.
//
// This exists because `open site/index.html` does not work. `landing.js` is a
// module, and every browser refuses a module script from a `file://` origin --
// so the page renders (it ships in its finished state on purpose) while the
// theme toggle, the copy buttons, the reveal and all five animations are
// silently dead. That failure looks exactly like the script being broken.
//
// Nothing is watched and nothing is rebuilt while this runs. It does not need
// to be: the page is served as it is written, so editing index.html, the
// stylesheet or the module and reloading is the whole loop. Only the icon and
// the og:image are staged, and those change about once a year.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const opts = { port: 8080, open: true };

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '-p' || a === '--port') opts.port = Number(process.argv[++i]);
  else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
  else if (a === '--no-open') opts.open = false;
  else {
    console.error(`Unknown argument: ${a}\n\n  npm run site -- [-p <n>] [--no-open]`);
    process.exit(1);
  }
}

const server = http.createServer((req, res) => {
  const send = (code, body, type = MIME['.txt']) => {
    // Nothing is cached, however briefly. A stylesheet held for a minute during
    // a round of edits is a change that looks like it did not land.
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };

  const url = new URL(req.url, 'http://127.0.0.1');
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(SITE, rel.endsWith('/') || rel === '' ? `${rel}index.html` : rel);

  // Whatever the path said, it has to land inside site/. This listens on the
  // loopback only, so the exposure is small, but a static server that will hand
  // out ../../.ssh for the asking is not a thing to leave lying in a repo.
  if (path.relative(SITE, file).startsWith('..')) return send(403, 'Forbidden');

  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(404, `Not found: /${rel}`);
  }

  send(200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
});

// The same next-free-port walk the reader's own CLI does, for the same reason:
// a second window on the same page should not be an error message.
const port = await new Promise((resolve, reject) => {
  const tryPort = (p, left) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && left > 0) tryPort(p + 1, left - 1);
      else reject(err);
    });
    server.listen(p, '127.0.0.1', () => resolve(server.address().port));
  };
  tryPort(Number.isFinite(opts.port) ? opts.port : 8080, 20);
});

const url = `http://127.0.0.1:${port}/`;
console.log(`redline site  ${SITE}`);
console.log(`              ${url}   (ctrl-c to stop)`);

if (opts.open) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const p = spawn(cmd, [url], {
    stdio: 'ignore',
    detached: true,
    shell: process.platform === 'win32',
  });
  p.unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
