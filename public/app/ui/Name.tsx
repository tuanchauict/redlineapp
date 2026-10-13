// The name on the bar, over the path behind it: hovering the name swaps it for the path, the way
// a Finder window titles itself, because with files open from several places the name alone does
// not say which. Drawn from `barName`, which `paint` and `showWelcome` in main.ts set.
import { render } from 'preact';
import { barName } from '../state.js';
import { ltrPath } from './TabLabel.js';

function Name() {
  const { name, dir, path } = barName.value;
  // With no path -- nothing open, or a file granted by itself, which has no folder to name -- the
  // swap would only blank the bar under the pointer, so the box is marked as having none.
  return (
    <span id="nameBox" class={dir ? 'name' : 'name no-path'} title={path}>
      <span id="name" class="name-file">
        {name}
      </span>
      <span id="nameDir" class="name-dir">
        {ltrPath(dir)}
      </span>
    </span>
  );
}

/** Draw the name into `root`, which it owns from here on. */
export function mountName(root: HTMLElement) {
  render(<Name />, root);
}
