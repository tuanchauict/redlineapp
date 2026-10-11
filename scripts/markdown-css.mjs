// github-markdown-css, with its palette keyed to the page's scheme rather than the system's.
//
//   import { keyToScheme } from './markdown-css.mjs';
//   const css = keyToScheme(fs.readFileSync(source, 'utf8'));
//
// The package's own stylesheet carries both palettes, each as custom properties behind
// `@media (prefers-color-scheme: …)`. That is the system's answer, and the page has a setting
// that can disagree with it: a browser tab cannot be told it is dark, as the shell tells a
// window, so the page says so itself, as `data-scheme` on <html> (index.html's head script, and
// `applyScheme` in app.js), and every stylesheet reads that instead. The `[data-theme]` hook the
// package offers is inside the same media queries, so it cannot be used to override them.
//
// Not the package's single-scheme files either: those have the colours written into each rule,
// and Sepia tints this one by re-setting its custom properties (styles.css).
//
// So the light palette becomes the stylesheet's own, and the dark one applies under
// `data-scheme="dark"`, on screen only: a printed page is always light (docs/reading.md), and
// the print block in styles.css resets only the page's palette, not this one. Everything else
// in the file is left as it ships.

const PALETTE = new RegExp(
  String.raw`@media \(prefers-color-scheme: (dark|light)\) \{\s*` +
    String.raw`\.markdown-body, \[data-theme="\1"\] \{([^}]*)\}\s*\}`,
  'g',
);

/**
 * @param {string} css  github-markdown-css's `github-markdown.css`.
 * @returns {string}
 */
export function keyToScheme(css) {
  const seen = [];
  const out = css.replace(PALETTE, (_, scheme, body) => {
    seen.push(scheme);
    return scheme === 'light'
      ? `.markdown-body {${body}}`
      : `@media screen {\n  :root[data-scheme="dark"] .markdown-body {${body}}\n}`;
  });
  // A new release that moves the palettes, or adds a third, must stop the build rather than
  // ship a page that is light whatever it is set to -- or follows the system after all.
  if (seen.sort().join() !== 'dark,light' || out.includes('prefers-color-scheme')) {
    throw new Error(
      'github-markdown-css: expected one light and one dark palette behind ' +
        `prefers-color-scheme, found ${seen.join(', ') || 'none'} (scripts/markdown-css.mjs)`,
    );
  }
  return out;
}
