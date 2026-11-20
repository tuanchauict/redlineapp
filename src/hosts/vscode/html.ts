// The page, as a webview is given it: the staged `index.html` with its files named by the
// addresses the editor serves them from, and a policy of its own.
//
// Pure, and string in, string out, so that what the webview is allowed to do is a thing the
// suite can read. The CLI's policy is the floor (core/csp.ts): this swaps `'self'` -- which in a
// webview is the editor's own origin and not where the page's files are -- for the one source
// the editor says they come from, and shuts `connect-src`, since the page never talks to anything
// but the extension host, and that is not a network request.
import { directives, inlineScriptHashes, serialize } from '../../core/csp.js';

export interface WebviewHtmlOptions {
  /** The staged page's `index.html`, as it was written. */
  html: string;
  /** Where the page's directory is served from, as `webview.asWebviewUri` spells it. */
  base: string;
  /** `webview.cspSource`: the origin the editor serves local resources from. */
  cspSource: string;
  /**
   * What `host.js` seeds the page's preferences with, and the scheme the editor is in now. Both
   * ride in the document as `<meta>`, because the page reads them synchronously, before first
   * paint, and a message from the extension host arrives after it.
   */
  prefs: Record<string, string>;
  dark: boolean;
  /**
   * The file the panel shows. `host.js` keeps it in the webview's own state, which the editor
   * hands back to the extension when it restores the panel after a restart.
   */
  path?: string;
}

/** The policy a webview carries, as a header string. */
export function webviewPolicy(html: string, cspSource: string): string {
  return serialize(
    directives({
      'default-src': ["'none'"],
      'script-src': [cspSource, ...inlineScriptHashes(html)],
      'style-src': [cspSource, "'unsafe-inline'"],
      'img-src': [cspSource, 'data:', 'blob:', 'https:', 'http:'],
      'font-src': [cspSource, 'data:'],
      'connect-src': ["'none'"],
    }),
  );
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** A file of the page: not another site, not the root of this one, not an anchor. */
const own = (url: string): boolean => !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url);

export function webviewHtml({
  html,
  base,
  cspSource,
  prefs,
  dark,
  path,
}: WebviewHtmlOptions): string {
  const root = base.endsWith('/') ? base : `${base}/`;
  // Computed from the page as staged: a change to the head script changes its hash, and a stale
  // one would block the script the page needs to paint.
  const policy = webviewPolicy(html, cspSource);
  const meta = [
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(policy)}" />`,
    `<meta name="redline-prefs" content="${escapeAttr(JSON.stringify(prefs))}" />`,
    `<meta name="redline-scheme" content="${dark ? 'dark' : 'light'}" />`,
    ...(path == null ? [] : [`<meta name="redline-path" content="${escapeAttr(path)}" />`]),
  ].join('\n    ');

  const out = html
    .replace(
      /(<(?:script|link|img)\b[^>]*?\s(?:src|href)=")([^"]*)(")/g,
      (m, open: string, url: string, close: string) =>
        own(url) ? `${open}${root}${url}${close}` : m,
    )
    // First in the head: the policy applies to what follows it, and host.js reads the other two.
    .replace(/<head>/, `<head>\n    ${meta}`);
  if (out === html || !out.includes('redline-prefs')) {
    throw new Error('the staged page has no <head> to put the webview policy in');
  }
  return out;
}
