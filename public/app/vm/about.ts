// What this copy is, and whether there is a newer one. Only ever on request —
// the button in Settings or Check for Updates… in the app menu — because it is
// the one time the app reaches off the machine, and that should be something
// somebody chose. A browser tab has neither: run from a checkout, upgrading
// is `git pull`, and the section is `data-shell`. ui/Settings.tsx draws the
// answer from `update`.
import { update, prefsOpen } from '../state.js';
import { native } from '../layout/native.js';

/** Homebrew's own word for it: replacing a cask's app any other way leaves
 *  the cask believing the old version is still installed. */
const BREW_UPGRADE = 'brew upgrade --cask redline';

/** Where Download goes, when the button is a download; empty when it copies. */
let updateUrl = '';

export async function checkUpdate() {
  updateUrl = '';
  update.value = { note: 'Checking…', checking: true };
  try {
    const u = await native.checkUpdate();
    if (!u.newer) {
      update.value = { note: `${u.current} is the newest version` };
    } else if (u.brew) {
      update.value = {
        note: `${u.latest} is out — installed with Homebrew, so upgrade there`,
        cmd: BREW_UPGRADE,
        go: 'Copy',
      };
    } else {
      updateUrl = u.url;
      // The file, so the button says what it fetches before it is pressed.
      update.value = {
        note: `${u.latest} is out`,
        cmd: u.url.split('/').pop(),
        go: u.url ? 'Download' : null,
      };
    }
  } catch {
    update.value = { note: 'Could not reach the update server — try again later' };
  }
}

/** The answer's button: the download, or the Homebrew command copied. `cmd` is where it shows. */
export function getUpdate(cmd) {
  if (updateUrl) {
    native.openExternal(updateUrl);
    return;
  }
  // A clipboard refused is not worth a message: the command is on screen
  // and selectable, so select it and let ⌘C do the rest.
  navigator.clipboard.writeText(BREW_UPGRADE).catch(() => {
    getSelection().selectAllChildren(cmd);
  });
}

// The menu sends this in the desktop app; the sheet scrolls to About itself,
// once it is up.
if (native) {
  native.onCheckUpdate(() => {
    prefsOpen.value = 'aboutSec';
    checkUpdate();
  });
}
