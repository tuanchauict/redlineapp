// Where a link in a document points, worked out from the directory the document is in.
//
// In core/ rather than in the page so that the cases can be tested in node, and because the
// answer is not only a POSIX path any more: a document may live at `C:\notes`, at
// `vscode-remote://ssh-remote+box/home/me`, or in a folder the web app was granted
// (`web:<rootId>/…`). The one rule across all of them is that a `..` stops at the root of its
// own kind of address and never climbs into the next one.

// The part of an address that `..` must never pop. Tried in this order; the first to match wins.
const ROOTS = [
  /^[a-z][a-z0-9+.\-]*:\/\/[^/\\]*/i, // scheme://authority
  /^web:[^/\\]*/, // web:<rootId>
  /^[a-zA-Z]:(?=[/\\]|$)/, // C:
];

/** `[prefix, rest]` -- the root `..` cannot pop, and everything after it. */
function splitRoot(dir) {
  for (const re of ROOTS) {
    const m = re.exec(dir);
    if (m) return [m[0], dir.slice(m[0].length)];
  }
  return ['', dir];
}

/**
 * Walk a relative link from the directory the document is in. Done here rather
 * than with `new URL`, which would resolve it against this page's address: a
 * `../` from the root that a loopback server serves from clamps away silently,
 * turning a real sibling directory into the wrong file with no sign of it.
 *
 * The separator is the one `dir` is written with -- `\` when it has that and no `/` -- so a
 * Windows path comes back as one. A backslash in `rel` only counts as a separator there: on a
 * POSIX path it is a character in a file name.
 */
export function walkPath(dir, rel) {
  const [prefix, rest] = splitRoot(dir);
  const backslash = rest.includes('\\') || /^[a-zA-Z]:$/.test(prefix);
  const sep = backslash && !rest.includes('/') ? '\\' : '/';

  // The first piece is '' when the rest is rooted, and stands for the root itself: nothing
  // above it can be popped. A trailing separator leaves another '' behind it, which is dropped
  // so that a link from `/` is `/a` and not `//a`.
  const parts = rest.split(sep === '\\' ? /[\\/]/ : '/');
  while (parts.length > 1 && parts.at(-1) === '') parts.pop();

  for (const seg of rel.split(sep === '\\' ? /[\\/]/ : '/')) {
    if (!seg || seg === '.') continue;
    if (seg !== '..') parts.push(seg);
    // Only the root is above everything; a link cannot climb past it.
    else if (parts.length > 1) parts.pop();
  }
  return prefix + (parts.join(sep) || sep);
}

/**
 * `~` for home, matching the directory under the filename and the sidebar.
 *
 * What the label stands for is worked out from the pair the document already carries -- its
 * real directory and the shortened one -- rather than assumed to be home: whatever they do not
 * share at the end is the real prefix and the one it was shown as. Resolving against the
 * short form directly would clamp a link that climbs above home to `~`; this way it comes out
 * as the path it actually points at.
 */
export function shorten(abs, d) {
  const { dir, dirLabel: label } = d;
  if (!dir || !label) return abs;

  // The longest common suffix, then backed off to where a separator starts it, so that a
  // directory called `notes` is not taken to share a suffix with one called `footnotes`.
  let k = 0;
  while (k < dir.length && k < label.length && dir.at(-1 - k) === label.at(-1 - k)) k++;
  while (k > 0 && !/[/\\]/.test(dir[dir.length - k])) k--;

  const real = dir.slice(0, dir.length - k);
  const shown = label.slice(0, label.length - k);
  if (!real || real === shown) return abs;
  if (abs === real) return shown;
  const next = abs[real.length];
  return abs.startsWith(real) && (next === '/' || next === '\\')
    ? shown + abs.slice(real.length)
    : abs;
}
