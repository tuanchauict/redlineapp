// A file's name over its directory, as the sidebar's rows, the chevron's menu and the bar all
// write it: two files called README.md are told apart by the only thing that differs, and it is
// the line that can be clipped.

/**
 * A path, wrapped so it reads left to right inside a box that clips from the
 * left. `.name-dir` / `.label-dir` are `direction: rtl` to put the ellipsis at
 * the front; without an isolate around the text, the leading slash is a
 * neutral character and lands at the far end instead — `/tmp/x` as `tmp/x/`.
 */
export const ltrPath = (p: string | undefined) => (p ? `\u2066${p}\u2069` : '');

/** One of the open files, as the shell pushes them or the web app keeps them. */
export interface Tab {
  id: string;
  name: string;
  dir: string;
  path: string;
  /** The longer form the web app has for a file granted by itself; the title, if there is one. */
  label?: string;
}

export function TabLabel({ tab }: { tab: Tab }) {
  return (
    <span class="label">
      <span class="label-name">{tab.name}</span>
      <span class="label-dir">{ltrPath(tab.dir)}</span>
    </span>
  );
}
