// What more than one test file needs. Each file under test/ runs in a process of its own, so
// nothing here is state: these are helpers, and a server or a temporary directory belongs to the
// file that made it.

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
