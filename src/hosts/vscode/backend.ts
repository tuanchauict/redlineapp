// The page's end of the VS Code extension: the seam's shape, over the webview's `postMessage`.
//
// The reader is not in the page. It is in the extension host (extension.ts), next to the files,
// and everything here is `createRpcBackend` pointed at the one channel a webview has. The page
// is written against the same `Backend` it is in the other hosts, and gets the reader's own
// payloads, untouched.
//
// Bundled to public/vendor/backend-vscode.js, and loaded only when `host.js` has said this is the
// extension, so no other build downloads it.
import { createRpcBackend } from '../../rpc/client.js';
import type { RpcBackend } from '../../rpc/client.js';

/** What `acquireVsCodeApi()` returns, of which `host.js` took the one call a page gets. */
export interface WebviewApi {
  postMessage(message: unknown): void;
}

declare global {
  // `var`, so that it is a property of `globalThis`, where `host.js` put it.
  var __REDLINE_VSCODE_API: WebviewApi | undefined;
}

export function createVscodeBackend({ docId }: { docId: () => string | null }): RpcBackend {
  const api = globalThis.__REDLINE_VSCODE_API;
  if (!api) {
    throw new Error('the extension host shim has not run: host.js is not first in the page');
  }
  return createRpcBackend({
    docId,
    post: (msg) => api.postMessage(msg),
    // Everything the extension host sends comes here, the protocol's messages and `host.js`'s
    // `scheme` alike; the client ignores a `t` it does not know.
    onMessage(handler) {
      const hear = (e: MessageEvent) => handler(e.data);
      addEventListener('message', hear);
      return () => removeEventListener('message', hear);
    },
    host: { kind: 'vscode' },
  });
}
