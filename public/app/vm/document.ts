// The document on screen: loading it, taking a payload as it, and drawing it.
//
// A port for now. The functions are still main.ts's -- they reach the welcome, the open files,
// the watch and the sidebars, which are not viewmodels yet -- and main.ts hands them in with
// `bindDocument` before anything can call them. What it buys is the direction of the imports:
// History, the view and Settings each need to redraw the document, and naming these here rather
// than main.ts is what lets them do it without importing the module that imports them. When the
// document core moves in, its importers do not change.

export interface DocumentCore {
  /** Ask for the document again and paint it. Whether it painted one. */
  load(opts?: { keepScroll?: boolean }): Promise<boolean>;
  /** Take a payload as the document this page is showing. */
  adopt(data): void;
  /** Draw `state.data` into `#doc` and everything around it. */
  paint(opts?: { reuse?: boolean }): void;
  /** Draw the payload already held over again, the pixel offset kept. */
  rerender(): void;
}

let core: DocumentCore | null = null;

/** main.ts's, once, at the top of its start-up: nothing here is called before the page loads. */
export function bindDocument(given: DocumentCore) {
  core = given;
}

export const load = (opts?: { keepScroll?: boolean }) => core.load(opts);
export const adopt = (data) => core.adopt(data);
export const paint = (opts?: { reuse?: boolean }) => core.paint(opts);
export const rerender = () => core.rerender();
