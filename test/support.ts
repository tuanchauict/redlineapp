// What more than one test file needs. Each file under test/ runs in a process of its own, so
// nothing here is state: these are helpers, and a server or a temporary directory belongs to the
// file that made it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootUrl } from '../src/hosts/node/root.js';

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
