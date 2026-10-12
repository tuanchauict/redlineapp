// The page's handles on its own markup, shared by every module that reaches into it. Nothing
// here imports the rest of the page, so any module can import this.
//
// Every id is in index.html, so the element is there, and the caller is the one that knows
// which kind it is: `$<HTMLInputElement>('findInput')`.
export const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;
export const doc = $('doc');
// The scroll area is the document pane, not the page — see `main` in the CSS.
export const pane = document.querySelector('main');
