// What more than one test file needs. Each file under test/ runs in a process of its own, so
// nothing here is state: these are helpers, and a server or a temporary directory belongs to the
// file that made it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { createServer } from '../src/hosts/node/server.js';
import { createMarkdown } from '../src/core/render.js';
import { renderDocument } from '../src/core/document.js';
import { rootUrl } from '../src/hosts/node/root.js';

// Every server here listens on a TCP port, so address() is an AddressInfo; the string it can also
// be is a pipe's path, and nothing in the suite listens on one.
export const portOf = (s: { address(): string | AddressInfo | null }) =>
  (s.address() as AddressInfo).port;

/**
 * A temporary directory for one test file, and the store under it. REDLINE_HOME is read when a
 * reader starts, so the servers of one file never share a history with another's, or with yours.
 * Removed once the file's tests are done.
 */
export function scratch(prefix = 'redline-') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.REDLINE_HOME = path.join(tmp, 'home');
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

/** A server on `file`, on a port of its own, closed when the file's tests are done. */
export async function serve(file: string) {
  const reader = await createServer({ file });
  const { server } = reader;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { reader, server, base: `http://127.0.0.1:${portOf(server)}` };
}

/** A content security policy as directive -> sources, so two can be compared by meaning. */
export const policy = (csp: string) =>
  Object.fromEntries(
    csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]),
  );

/** A file of the repository, by its path from the root. */
export const read = (p: string) => fs.readFileSync(rootUrl(p), 'utf8');

// The page's source is every module under public/app/, read as one text: the greps that use it
// are about what the page does, and which file of it a line moved to is not their business.
export const pageSource = () => {
  const dir = fileURLToPath(rootUrl('public/app/'));
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
};

// The greps on how the page is written read the source, because tsc and esbuild reprint what
// they emit. The server hands public/ out as it is, so the files are what a tab is served; what
// the server adds, a header, is checked where it is served.
export const pageJs = pageSource();
export const pageHtml = read('public/index.html');
export const pageCss = read('public/styles.css');
export const pageHead = pageHtml.slice(0, pageHtml.indexOf('</head>'));
// The Settings sheet is a component, so its markup is read from where it is written.
export const settingsTsx = read('public/app/ui/Settings.tsx');

// HTML's own void elements: the only tags a balanced fragment may leave open.
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
  'track', 'wbr',
]);

/**
 * Why `html` does not nest, or null if it does. The marks are injected into rendered HTML, so the
 * main risk is producing tags that interleave -- `<strong><ins>x</strong>y</ins>` and friends.
 */
export function unbalanced(html: string) {
  const stack = [];
  for (const [, closing, name, selfClosing] of html.matchAll(
    /<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g,
  )) {
    // `<path … />` inside the SVG icons closes itself, and XML allows that of
    // any element — it is only HTML's own tags that must be in the void list.
    if (selfClosing || VOID_TAGS.has(name.toLowerCase())) continue;
    if (!closing) stack.push(name);
    else if (stack.pop() !== name) return `</${name}> does not close the open element`;
  }
  return stack.length ? `unclosed <${stack.join('>, <')}>` : null;
}

// The server sends the two versions of the text and the page renders them, so a test renders
// them too -- what is asserted is what a reader ends up looking at, one step on from the
// response. Exactly what `adopt` does in the page, for the same reason: rendering it a second way
// here would be testing something nobody runs.
export const mdPage = createMarkdown();
export const render = (d) =>
  d.text == null
    ? d
    : Object.assign(d, renderDocument(mdPage, d.text, d.base, { keys: d.acked, from: d.ackedFrom }));
/** A reader talking to one server: fetch a document, render it, as the page does. */
export const clientFor = (origin: string) => async (p: string, init?: RequestInit) =>
  render(await (await fetch(origin + p, init)).json());

/**
 * `fn`'s answer once it has one. Reading a repo, a watch, another process: these land after the
 * call that started them, so a test waits for them rather than assuming.
 */
export const until = async (fn, what, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

// IndexedDB as a Map, for the web platform and the web reader. `tx` stages what `fn` does and keeps it only if `fn`
// finishes, one transaction at a time: the two things a readwrite transaction gives. What a Map
// cannot do is end a transaction early, which is the thing `idb.ts` has to be built not to need.
export const memoryKv = () => {
  const data = new Map();
  const seen = { puts: 0 };
  const over = (m) => ({
    get: async (k) => structuredClone(m.get(k)),
    put: async (k, v) => void (seen.puts++, m.set(k, structuredClone(v))),
    del: async (k) => void m.delete(k),
    keys: async (prefix) => [...m.keys()].filter((k) => k.startsWith(prefix)).sort(),
  });
  let queue = Promise.resolve();
  const tx = (fn) => {
    const run = queue.then(async () => {
      const staged = new Map(data);
      const out = await fn(over(staged));
      data.clear();
      for (const [k, v] of staged) data.set(k, v);
      return out;
    });
    queue = run.catch(() => {});
    return run;
  };
  const now = over(data);
  return {
    data,
    seen,
    get: now.get,
    keys: now.keys,
    put: (k, v) => tx((t) => t.put(k, v)),
    del: (k) => tx((t) => t.del(k)),
    tx,
  };
};
