#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from '../src/server.js';
import { DocStore } from '../src/store.js';
import { nodePlatform } from '../src/platform-node.js';

const USAGE = `redline — minimal GitHub-style markdown reader with change highlighting

  redline <file.md> [options]

Options:
  -p, --port <n>        Port to listen on (default: 7391, next free port if taken)
      --no-open         Do not open a browser
      --app             Open in a chromeless Chrome/Edge window (good for side-by-side)
      --plantuml-jar <p>  Path to plantuml.jar (also read from $PLANTUML_JAR)
  -h, --help            Show this help
`;

function parseArgs(argv) {
  const opts = { file: null, port: 7391, open: true, app: false, plantumlJar: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-p' || a === '--port') opts.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else if (a === '--plantuml-jar') opts.plantumlJar = argv[++i];
    else if (a.startsWith('--plantuml-jar=')) opts.plantumlJar = a.slice(15);
    else if (a === '--no-open') opts.open = false;
    else if (a === '--app') opts.app = true;
    else if (!a.startsWith('-') && !opts.file) opts.file = a;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

function openBrowser(url, appMode) {
  if (appMode && process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Brave Browser']) {
      try {
        const p = spawn('open', ['-na', app, '--args', `--app=${url}`, '--window-size=760,1000'], {
          stdio: 'ignore',
          detached: true,
        });
        p.unref();
        return;
      } catch {
        /* try the next browser */
      }
    }
  }
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const p = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
  p.unref();
}

function listen(server, port, attempts = 20) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && left > 0) tryPort(p + 1, left - 1);
        else reject(err);
      });
      server.listen(p, '127.0.0.1', () => resolve(server.address().port));
    };
    tryPort(port, attempts);
  });
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help || !opts.file) {
  console.log(USAGE);
  process.exit(opts.file ? 0 : 1);
}

const abs = path.resolve(opts.file);
if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
  console.error(`Not a file: ${abs}`);
  process.exit(1);
}

// Not awaited: nothing below depends on it, and a reader should not wait on a
// sweep of somebody else's old snapshots to see their own file.
DocStore.gc(nodePlatform);

const { server, plantuml } = await createServer({ file: abs, plantumlJar: opts.plantumlJar });
const port = await listen(server, Number.isFinite(opts.port) ? opts.port : 7391);
const url = `http://127.0.0.1:${port}/`;

console.log(`redline  ${abs}`);
console.log(`           ${url}   (ctrl-c to stop)`);
// Only worth a line when the document actually asks for PlantUML.
if (!plantuml.available && /^\s*```+\s*(plantuml|puml|uml|pu|iuml)\b/im.test(fs.readFileSync(abs, 'utf8'))) {
  console.log(`           plantuml: ${plantuml.hint}`);
}
if (opts.open) openBrowser(url, opts.app);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
