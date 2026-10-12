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
import vm from 'node:vm';
import { build, transformSync } from 'esbuild';
import { createServer } from '../src/hosts/node/server.js';
import { createMarkdown } from '../src/core/render.js';
import { renderDocument } from '../src/core/document.js';
import { rootUrl } from '../src/hosts/node/root.js';

// Every server here listens on a TCP port, so address() is an AddressInfo; the string it can also
// be is a pipe's path, and nothing in the suite listens on one.
export const portOf = (s: { address(): string | AddressInfo | null }) =>
  (s.address() as AddressInfo).port;

// What the suite reads out of the server's JSON, which `Response.json()` types as `unknown`.
// Only the members some assertion reads are here; which reply carries which is the server's.
export interface Version {
  hash: string;
  current?: boolean;
  baseline?: boolean;
  git?: { subject: string };
}
// What `reader.read()` resolves to; the stand-in a closed stream is caught with has no value.
export interface Chunk {
  done: boolean;
  value?: Uint8Array;
}
export interface Reply {
  name?: string;
  id?: string;
  path?: string;
  text?: string;
  tracked?: boolean;
  baseline?: string;
  baselineAvailable?: boolean;
  removed?: number;
  history?: Version[];
  acked?: string[];
  fonts?: string[];
  svg?: string;
  error?: string;
}

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

// What runs in a vm has to be JavaScript, and annotated TypeScript is not: the checks that run the
// page's functions over fakes lift their text out of main.ts and the viewmodels with its types
// stripped, where the greps for how the source is written read the .ts. Stripped, not read from
// the bundle: app.js has Preact scope-hoisted in beside the page, and esbuild renames the page's
// top-level names wherever they meet Preact's minified ones -- `$` is `$2` there -- so a lifted
// function would call a helper the vm's fakes do not name. Transforming file by file renames
// nothing. Made the first time it is asked for, since most files never do.
let pageRunText: string | undefined;
export const pageRun = () =>
  (pageRunText ??= ['main.ts', 'vm/changes.ts', 'vm/acks.ts', 'vm/settings.ts']
    .map((file) => fs.readFileSync(rootUrl(`public/app/${file}`), 'utf8'))
    .map((ts) => transformSync(ts, { loader: 'ts', target: 'es2022' }).code)
    .join('\n'));

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

// ---------- the page, run ----------

// The viewmodels wire themselves as they load -- a listener on `#find`, a resize handler -- so
// what they do can only be seen by loading one. That is what follows: a module of public/app/,
// bundled with esbuild as `build:web` bundles the page, with chosen imports swapped for stubs,
// run in a vm over a window of its own. A window per load, so module state never leaks between
// two tests, and the real index.html as its markup, so a module wiring an id the page does not
// have fails here as it would in a tab.
//
// The DOM is a fake, and a small one: what the page's modules touch and no more. No DOM library
// is a dependency, and the one feature that needs real text nodes -- find -- needs only these.

/** An event as a listener sees it. `init` is copied on: `key`, `shiftKey`, `relatedTarget`. */
class FakeEvent {
  type: string;
  bubbles = true;
  defaultPrevented = false;
  stopped = false;
  target = null;
  currentTarget = null;
  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.stopped = true;
  }
}

class FakeTarget {
  #on = new Map<string, { fn: (e) => void; once: boolean }[]>();
  addEventListener(type: string, fn, opts?) {
    if (!this.#on.has(type)) this.#on.set(type, []);
    this.#on.get(type).push({ fn, once: typeof opts === 'object' && !!opts?.once });
  }
  removeEventListener(type: string, fn) {
    this.#on.set(type, (this.#on.get(type) ?? []).filter((l) => l.fn !== fn));
  }
  /** Heard here and, for one that bubbles, on every ancestor -- capture is not modelled. */
  dispatchEvent(e: FakeEvent) {
    e.target ??= this;
    for (let at: FakeTarget = this; at && !e.stopped; at = e.bubbles ? at.up() : null) {
      e.currentTarget = at;
      for (const l of [...(at.#on.get(e.type) ?? [])]) {
        if (l.once) at.removeEventListener(e.type, l.fn);
        l.fn.call(at, e);
      }
    }
    return !e.defaultPrevented;
  }
  /** Where an event goes after this. */
  up(): FakeTarget | null {
    return null;
  }
  listening(type: string) {
    return (this.#on.get(type) ?? []).length;
  }
}

const VOID = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'wbr', 'col', 'area']);
const unesc = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[e]);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const camel = (s: string) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase());
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

// One compound selector (`button:not(:disabled)`, `.chg[data-key]`, `mark.search-hit`), as its
// parts. A combinator is not one of them: nothing the page asks of a fake needs one but
// `:scope > x`, which `querySelectorAll` takes itself, and anything else throws rather than
// matching wrong.
const PART = /^(?:([a-z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]|:not\(([^()]*)\)|:(disabled))/i;
function matchesCompound(el, sel: string): boolean {
  let rest = sel.trim();
  while (rest) {
    const m = rest.match(PART);
    if (!m) throw new Error(`the fake DOM has no selector like ${JSON.stringify(sel)}`);
    rest = rest.slice(m[0].length);
    const [, tag, id, cls, attr, value, not, disabled] = m;
    if (tag && tag !== '*' && el.localName !== tag.toLowerCase()) return false;
    if (id && el.id !== id) return false;
    if (cls && !el.classList.contains(cls)) return false;
    if (attr && (value === undefined ? !el.hasAttribute(attr) : el.getAttribute(attr) !== value))
      return false;
    if (not && matchesCompound(el, not)) return false;
    if (disabled && !el.disabled) return false;
  }
  return true;
}
const matchesList = (el, sel: string) => sel.split(',').some((s) => matchesCompound(el, s));

/** A window, its document parsed from `html` (the page's own unless given), for one load. */
export function fakeWindow({
  html = pageHtml,
  search = '',
  width = 1200,
  height = 800,
  dark = false,
  store = new Map<string, string>(),
} = {}) {
  class Node extends FakeTarget {
    parentNode = null;
    childNodes = [];
    nodeType = 0;
    up() {
      return this.parentNode ?? ((this as Node) === document ? win.__target : null);
    }
    get parentElement() {
      return this.parentNode instanceof Element ? this.parentNode : null;
    }
    get firstChild() {
      return this.childNodes[0] ?? null;
    }
    get isConnected() {
      let n: Node = this;
      while (n.parentNode) n = n.parentNode;
      return n === document;
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(t) {
      this.replaceChildren(...(t ? [new Text(String(t))] : []));
    }
    appendChild(c) {
      c.remove();
      c.parentNode = this;
      this.childNodes.push(c);
      return c;
    }
    append(...cs) {
      for (const c of cs) this.appendChild(typeof c === 'string' ? new Text(c) : c);
    }
    replaceChildren(...cs) {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = [];
      this.append(...cs);
    }
    remove() {
      const p = this.parentNode;
      if (!p) return;
      p.childNodes.splice(p.childNodes.indexOf(this), 1);
      this.parentNode = null;
    }
    replaceWith(...cs) {
      const p = this.parentNode;
      const nodes = cs.map((c) => (typeof c === 'string' ? new Text(c) : c));
      for (const n of nodes) n.remove();
      p.childNodes.splice(p.childNodes.indexOf(this), 1, ...nodes);
      for (const n of nodes) n.parentNode = p;
      this.parentNode = null;
    }
    /** As the DOM's: adjacent text nodes merged, empty ones dropped, all the way down. */
    normalize() {
      const out = [];
      for (const c of this.childNodes) {
        if (c.nodeType === 3) {
          if (!c.nodeValue) {
            c.parentNode = null;
            continue;
          }
          if (out.at(-1)?.nodeType === 3) {
            out.at(-1).nodeValue += c.nodeValue;
            c.parentNode = null;
            continue;
          }
        } else c.normalize();
        out.push(c);
      }
      this.childNodes = out;
    }
    /** Every element under this one, in document order. */
    *elements(): Generator<Element> {
      for (const c of this.childNodes) {
        if (c instanceof Element) {
          yield c;
          yield* c.elements();
        }
      }
    }
    querySelectorAll(sel: string) {
      const scoped = sel.match(/^:scope\s*>\s*(.+)$/);
      if (scoped) return this.childNodes.filter((c) => c instanceof Element && c.matches(scoped[1]));
      return [...this.elements()].filter((el) => el.matches(sel));
    }
    querySelector(sel: string) {
      return this.querySelectorAll(sel)[0] ?? null;
    }
  }

  class Text extends Node {
    nodeType = 3;
    nodeValue: string;
    constructor(v: string) {
      super();
      this.nodeValue = v;
    }
    get textContent() {
      return this.nodeValue;
    }
    set textContent(v) {
      this.nodeValue = String(v);
    }
  }

  const classList = () => {
    const s = new Set<string>();
    return {
      add: (...c) => c.forEach((x) => s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      toggle: (c, on = !s.has(c)) => (on ? s.add(c) : s.delete(c), on),
      contains: (c) => s.has(c),
      get value() {
        return [...s].join(' ');
      },
      set value(v) {
        s.clear();
        for (const c of String(v).split(/\s+/)) if (c) s.add(c);
      },
      [Symbol.iterator]: () => s[Symbol.iterator](),
    };
  };
  // The custom properties are what layout writes; anything else (`left`, `top`) is a property.
  const style = () => {
    const vars = new Map<string, string>();
    return {
      setProperty: (k, v) => void vars.set(k, String(v)),
      removeProperty: (k) => void vars.delete(k),
      getPropertyValue: (k) => vars.get(k) ?? '',
      vars,
    };
  };

  class Element extends Node {
    nodeType = 1;
    localName: string;
    attrs = new Map<string, string>();
    classList = classList();
    dataset: Record<string, string> = {};
    style = style();
    scrollTop = 0;
    offsetWidth = 0;
    offsetHeight = 0;
    value = '';
    /** What `getBoundingClientRect` answers, set by a test that needs a layout. */
    rect = null;
    scrolledIntoView = null;
    constructor(tag: string) {
      super();
      this.localName = tag.toLowerCase();
    }
    get tagName() {
      return this.localName.toUpperCase();
    }
    get id() {
      return this.attrs.get('id') ?? '';
    }
    set id(v) {
      this.attrs.set('id', v);
    }
    get className() {
      return this.classList.value;
    }
    set className(v) {
      this.classList.value = v;
    }
    // Boolean attributes, which are what a stylesheet and `[hidden]` read.
    get hidden() {
      return this.attrs.has('hidden');
    }
    set hidden(v) {
      if (v) this.attrs.set('hidden', '');
      else this.attrs.delete('hidden');
    }
    get disabled() {
      return this.attrs.has('disabled');
    }
    set disabled(v) {
      if (v) this.attrs.set('disabled', '');
      else this.attrs.delete('disabled');
    }
    get open() {
      return this.attrs.has('open');
    }
    set open(v) {
      if (v) this.attrs.set('open', '');
      else this.attrs.delete('open');
    }
    getAttribute(k: string) {
      if (k === 'class') return this.className || null;
      if (k.startsWith('data-')) return this.dataset[camel(k.slice(5))] ?? null;
      return this.attrs.get(k) ?? null;
    }
    setAttribute(k: string, v) {
      if (k === 'class') this.className = String(v);
      else if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v);
      else this.attrs.set(k, String(v));
    }
    hasAttribute(k: string) {
      return this.getAttribute(k) !== null;
    }
    removeAttribute(k: string) {
      if (k === 'class') this.className = '';
      else if (k.startsWith('data-')) delete this.dataset[camel(k.slice(5))];
      else this.attrs.delete(k);
    }
    matches(sel: string) {
      return matchesList(this, sel);
    }
    closest(sel: string) {
      for (let n: Node = this; n instanceof Element; n = n.parentNode) if (n.matches(sel)) return n;
      return null;
    }
    focus() {
      document.activeElement = this;
    }
    blur() {
      if (document.activeElement === this) document.activeElement = document.body;
    }
    select() {}
    setPointerCapture() {}
    getBoundingClientRect() {
      return this.rect ?? { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    scrollTo(x, y?) {
      this.scrollTop = typeof x === 'object' ? (x.top ?? this.scrollTop) : y;
    }
    scrollIntoView(o) {
      this.scrolledIntoView = o ?? true;
    }
    click() {
      this.dispatchEvent(new FakeEvent('click'));
    }
    get outerHTML() {
      const attrs = [...(this.className ? [['class', this.className]] : []), ...this.attrs,
        ...Object.entries(this.dataset).map(([k, v]) => [`data-${kebab(k)}`, v])]
        .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${esc(v)}"`)).join('');
      const open = `<${this.localName}${attrs}>`;
      return VOID.has(this.localName) ? open : `${open}${this.innerHTML}</${this.localName}>`;
    }
    get innerHTML() {
      return this.childNodes.map((c) => (c instanceof Element ? c.outerHTML : esc(c.nodeValue)))
        .join('');
    }
    set innerHTML(html) {
      this.replaceChildren(...parse(String(html)));
    }
  }

  /**
   * HTML as the fake's nodes. Enough of the grammar for index.html and the markup a test writes:
   * tags, quoted or bare attributes, void and self-closed elements, comments and the doctype
   * dropped, and a script's text skipped, since nothing here runs it.
   */
  function parse(html: string) {
    const top = new Element('#fragment');
    let at: Node = top;
    const tokens = /<!--[\s\S]*?-->|<![^>]*>|<script\b[^>]*>[\s\S]*?<\/script>|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</g;
    for (const [tok, closing, tag, attrs, self] of html.matchAll(tokens)) {
      if (!tag) {
        if (!tok.startsWith('<!') && !/^<script/i.test(tok)) at.appendChild(new Text(unesc(tok)));
        continue;
      }
      if (closing) {
        for (let n = at; n !== top; n = n.parentNode) {
          if ((n as Element).localName === tag.toLowerCase()) {
            at = n.parentNode;
            break;
          }
        }
        continue;
      }
      const el = new Element(tag);
      for (const [, k, , dq, sq, bare] of attrs.matchAll(
        /([^\s=>/]+)(\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
      )) {
        el.setAttribute(k, unesc(dq ?? sq ?? bare ?? ''));
      }
      at.appendChild(el);
      if (!self && !VOID.has(el.localName)) at = el;
    }
    const nodes = [...top.childNodes];
    top.replaceChildren();
    return nodes;
  }

  class Document extends Node {
    nodeType = 9;
    documentElement: Element;
    body: Element;
    activeElement = null;
    title = '';
    constructor() {
      super();
      const root = parse(html).find((n) => n instanceof Element && n.localName === 'html') as Element;
      this.documentElement = root ?? new Element('html');
      this.appendChild(this.documentElement);
      this.body = this.documentElement.querySelector('body') ?? new Element('body');
      if (!this.body.parentNode) this.documentElement.appendChild(this.body);
    }
    // Null for an id the page does not have, as a browser's is -- that is the point of it.
    getElementById(id: string) {
      return [...this.elements()].find((el) => el.id === id) ?? null;
    }
    createElement(tag: string) {
      return new Element(tag);
    }
    createTextNode(v: string) {
      return new Text(v);
    }
    // Collected up front rather than live: what find does is walk all of them and then splice,
    // and a live walker over a tree it is changing would be a fake with behaviour of its own.
    createTreeWalker(root: Node) {
      const out = [];
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c.nodeType === 3) out.push(c);
          else walk(c);
        }
      };
      walk(root);
      let i = 0;
      return { nextNode: () => out[i++] ?? null };
    }
  }

  const document = new Document();
  document.activeElement = document.body;
  const prefs = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  const location = { href: `http://127.0.0.1/${search}`, search };
  const target = new FakeTarget();
  const media = { matches: dark, addEventListener() {}, removeEventListener() {} };
  const win = {
    __target: target,
    __REDLINE_PREFS: prefs,
    store,
    document,
    location,
    history: {
      replaceState(_s, _t, url) {
        location.href = String(url);
        location.search = new URL(location.href).search;
      },
    },
    innerWidth: width,
    innerHeight: height,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    matchMedia: () => media,
    getComputedStyle: (el) => el.style,
    requestAnimationFrame: (f) => setTimeout(f, 0),
    cancelAnimationFrame: (t) => clearTimeout(t),
    Node,
    Element,
    Text,
    Event: FakeEvent,
    NodeFilter: { SHOW_TEXT: 4 },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    structuredClone,
    parse,
    /** An event at `el`, as a listener on it or above it hears it. */
    fire: (el, type: string, init = {}) => el.dispatchEvent(new FakeEvent(type, init)),
    $: (id: string) => document.getElementById(id),
  };
  return win;
}
export type FakeWindow = ReturnType<typeof fakeWindow>;

/** What `vm` hands back is of its realm, and a deep-equal compares prototypes; this is plain. */
export const plain = (v) => JSON.parse(JSON.stringify(v));

/** A stand-in that answers `ret` (or what `ret` returns) and keeps what it was called with. */
export const spy = (ret?) => {
  const f = (...a) => {
    f.calls.push(a);
    return typeof ret === 'function' ? ret(...a) : ret;
  };
  f.calls = [] as unknown[][];
  return f;
};

const appDir = fileURLToPath(rootUrl('public/app/'));

// The bundle depends only on which modules and the shape of the stubs -- what a stub answers is
// read from the window at run time -- so a test that loads the same page a few hundred times
// over different windows bundles it once.
const bundles = new Map<string, Promise<string>>();
function bundlePage(modules: string[], stubs: Record<string, object>) {
  const shape = Object.entries(stubs).map(([k, v]) =>
    [k, Object.entries(v).map(([n, x]) => [n, typeof x === 'function'])]);
  const key = JSON.stringify([modules, shape]);
  if (!bundles.has(key)) bundles.set(key, buildPage(modules, stubs));
  return bundles.get(key);
}

async function buildPage(modules: string[], stubs: Record<string, object>) {
  const contents = modules.map((m, i) => `export * as m${i} from './${m}.js';`).join('\n');
  const out = await build({
    stdin: { contents, resolveDir: appDir, loader: 'ts', sourcefile: 'entry.ts' },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__page',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
    plugins: [
      {
        name: 'stubs',
        setup(b) {
          b.onResolve({ filter: /^\./ }, (args) => {
            const abs = path.resolve(args.resolveDir, args.path).replace(/\.(js|ts|tsx)$/, '');
            const key = path.relative(appDir, abs).split(path.sep).join('/');
            return key in stubs ? { path: key, namespace: 'stub' } : undefined;
          });
          b.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path: key }) => ({
            loader: 'js',
            contents: [
              `const s = globalThis.__stubs[${JSON.stringify(key)}];`,
              ...Object.entries(stubs[key]).map(([k, v]) =>
                typeof v === 'function'
                  ? `export const ${k} = (...a) => s.${k}(...a);`
                  : `export const ${k} = s.${k};`),
            ].join('\n'),
          }));
        },
      },
    ],
  });
  return out.outputFiles[0].text;
}

/**
 * Load `modules` of public/app/ (`'vm/history'`, `'state'`) into `win`, in order, with each
 * import named in `stubs` (by the same kind of path) answered from it instead. A function in a
 * stub is called through, so a test can swap it after the load; anything else is read once.
 * What comes back is each module's exports, by the name it was asked for.
 */
export async function loadPage(
  modules: string[],
  { stubs = {}, win = fakeWindow() }: { stubs?: Record<string, object>; win?: FakeWindow } = {},
) {
  const ctx = vm.createContext(Object.assign(win, { __stubs: stubs }));
  vm.runInContext(await bundlePage(modules, stubs), ctx);
  const page = (ctx as { __page: Record<string, Record<string, unknown>> }).__page;
  return Object.fromEntries(modules.map((m, i) => [m, page[`m${i}`]])) as Record<string, any>;
}

/** The inline script in index.html's head, run in `win` as a tab runs it before first paint. */
export const runHeadScript = (win: FakeWindow) =>
  vm.runInContext(pageHead.match(/<script>([\s\S]*?)<\/script>/)[1], vm.createContext(win));
