// Path arithmetic for a given separator, with no filesystem under it.
//
// Hosts that have no `node:path` -- the Tauri page, the web app, the VS Code extension host's
// webview side -- all need the same five helpers, and the store writes their answers into its
// own index, so two hosts that spell one file two ways would file one document under two names.
// They live here once. The behaviour is the one that was in hosts/tauri/platform.js before this
// file existed, lifted out unchanged; the test suite holds it against `node:path`'s posix and
// win32 for the cases it claims.

/**
 * @param {'/' | '\\'} sep
 * @returns {{
 *   sep: string,
 *   join: (...parts: string[]) => string,
 *   dirname: (p: string) => string,
 *   basename: (p: string) => string,
 *   resolve: (p: string) => string,
 * }}
 */
export function makePaths(sep) {
  /**
   * Join, the way the host would.
   *
   * Not `p.join('/')`: the store writes these paths into its own index and hands them back, so
   * two spellings of one file would not fail loudly -- they would file one document under two
   * names.
   */
  function join(...parts) {
    const out = parts
      .filter((p) => p !== '' && p != null)
      .join(sep)
      // Any run of either separator collapses: the pieces being joined come from both sides of
      // a bridge and only one of them is careful about trailing slashes.
      .replace(/[/\\]+/g, sep);
    return out || '.';
  }

  /**
   * Everything up to the last separator, or '.' when there is none.
   *
   * Not node's answer at the root of a drive: `C:\a` gives `C:` here, where node says `C:\`.
   * A caller that joins onto it gets the right path either way, which is all this is used for.
   */
  function dirname(p) {
    const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    if (at < 0) return '.';
    if (at === 0) return sep; // '/x' -- the root, not the empty string
    return p.slice(0, at);
  }

  function basename(p) {
    const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return at < 0 ? p : p.slice(at + 1);
  }

  /**
   * An absolute path, normalised.
   *
   * There is no working directory to resolve against -- the host only ever hands over paths it
   * got from the OS, from a dialog or from a command line it resolved itself. So this collapses
   * `.` and `..` and leaves everything else, which is what the store needs: it keys documents
   * on the answer, and two spellings of one file must not survive it.
   */
  function resolve(p) {
    if (!p) return p;
    const win = /^[a-zA-Z]:[/\\]/.test(p);
    const rooted = win || p.startsWith('/') || p.startsWith('\\');
    const drive = win ? p.slice(0, 2) : '';
    const parts = [];
    for (const part of (win ? p.slice(2) : p).split(/[/\\]+/)) {
      if (part === '' || part === '.') continue;
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
      else if (part !== '..' || !rooted) parts.push(part);
    }
    const body = parts.join(sep);
    return rooted ? drive + sep + body : body;
  }

  return { sep, join, dirname, basename, resolve };
}
