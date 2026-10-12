import { state } from './state.js';
import { mountHistory } from './ui/History.js';
import { mountContents } from './ui/Contents.js';
import { mountRuler } from './ui/Ruler.js';
import { mountFiles } from './ui/Files.js';
import { mountTabMenu } from './ui/TabMenu.js';
import { mountName } from './ui/Name.js';
import { mountChanges } from './ui/Changes.js';
import { bindChrome } from './ui/chrome.js';
import { mountWelcome } from './ui/Welcome.js';
import { mountSettings } from './ui/Settings.js';
import { $, pane } from './dom.js';
import './layout/widths.js';
import './layout/toc-height.js';
import { bindKeys } from './layout/keys.js';
import { native, firstTabShown, bindNative } from './layout/native.js';
import { listFonts } from './layout/fonts.js';
import { backend } from './backend.js';
import { openFind } from './vm/find.js';
import { changeNodes, hoverMarks, goToNode, goToChange } from './vm/changes.js';
import { clearAcks, tapCheck } from './vm/acks.js';
import { scrollToNode } from './vm/contents.js';
import { leftColumn, setSide, setTocSide, toggleTabMenu, closeTabMenu } from './vm/sidebars.js';
import {
  settings,
  keptBaseline,
  chooseBaseline,
  writeSettings,
  stepSize,
  openPrefs,
  initSettings,
} from './vm/settings.js';
import { toggleDiff, toggleView } from './vm/view.js';
import { checkUpdate, getUpdate } from './vm/about.js';
import { welcome, welcomeEl, showWelcome, backToDocument } from './vm/welcome.js';
import {
  pickVersion,
  setSolo,
  toggleSolo,
  tapMarkRead,
  openVerMenu,
  closeVerMenu,
  prune,
} from './vm/history.js';
import { openFiles, setDocId, load, connect } from './vm/core.js';
import { scrollMemory, selectTab, closeTab } from './vm/files.js';

// The browser's file picker, or the input that stands in for one: Open file…, and the page's own
// ways to it with a document on screen.
const pickFile = welcome ? mountWelcome(welcomeEl, welcome, () => backToDocument()) : null;

if (welcome) {
  // The way to another file with one on screen, as ⌘O is: straight to the browser's file picker,
  // and not the welcome over the document. What is picked joins the open files, and the one being
  // read stays a click away in them.
  $('newTab').title = 'Open a file (⌘O)';
  $('newTab').addEventListener('click', () => pickFile());
}

// The rows are drawn wherever the list is, the column open or shut, so opening it has nothing to
// fill in: the list is already the files open.
mountFiles($('fileList'), { select: selectTab, close: closeTab });

// The columns, their disclosures and the chevron's list are vm/sidebars.ts; their widths and the
// contents height are layout/widths.ts and layout/toc-height.ts, which wire their grips as they
// load.
mountTabMenu($('tabMenuSlot'), $('tabListSlot'), {
  toggle: toggleTabMenu,
  select(id) {
    closeTabMenu();
    selectTab(id);
  },
});

// ---------- contents ----------

// vm/contents.ts, which follows the scroll and takes the document's own links to its headings.
mountContents($('tocList'), { go: (node) => scrollToNode(node) });

// vm/files.ts takes the links that leave the document.

// ---------- history ----------

// The list is ui/History.tsx, and what it does is vm/history.ts. It is mounted here, because a
// viewmodel does not import the components that draw it.

mountHistory($('histList'), {
  pick: pickVersion,
  menu: openVerMenu,
  closeMenu: () => closeVerMenu(),
  prune,
});

// ---------- changes ----------

// The count, `n`/`p`, the ruler and check-offs are vm/changes.ts and vm/acks.ts. The ruler's
// marks are mounted here, because a viewmodel does not import the components that draw it.
mountRuler($('ruler'), {
  go: (node) => {
    state.changeIndex = changeNodes().indexOf(node);
    goToNode(node);
  },
  hover: hoverMarks,
});

// ---------- events ----------

mountChanges($('changesSlot'), {
  unsolo: () => setSolo(false),
  go: goToChange,
  unack: () => clearAcks(),
});

// The buttons keep to the signals from here on (ui/chrome.ts), already showing what the inline
// script and the prefs say.
bindChrome();
mountName($('nameSlot'));

// Run once with `remember` off, to set the widths from the classes the
// inline script put on the root before first paint. Nothing is
// being chosen here, so nothing is written back.
setSide(state.side, false);
setTocSide(state.tocSide, false);

// The view and the marks are vm/view.ts; the bar's button for the view is wired there.

// The letters, the scrolling and the ⌘ shortcuts: layout/keys.ts.
bindKeys({
  toggleView,
  toggleDiff,
  toggleSolo,
  goToChange,
  tapMarkRead,
  clearAcks,
  tapCheck,
  openPrefs,
  openFind,
  setSide,
  setTocSide,
  leftColumn,
  welcome,
  pickFile,
});

// ---------- native shell ----------

// layout/native.ts, bound here because this is where the block used to run: after the handlers
// it hands on exist, and before the settings and the first load are awaited below.
bindNative({
  toggleView,
  toggleDiff,
  goToChange,
  tapMarkRead,
  openFind,
  setSide,
  setTocSide,
  setDocId,
  connect,
  keptBaseline,
  load,
  scrollMemory,
});

// ---------- settings ----------

// vm/settings.ts, and the sheet ui/Settings.tsx, which shares the update check of vm/about.ts.
mountSettings($('prefsSlot'), native?.version ?? '', {
  write: writeSettings,
  step: stepSize,
  baseline: chooseBaseline,
  reveal: () => native?.revealStore(),
  check: checkUpdate,
  go: getUpdate,
});

// Before the first load: the text size, the width and the marks all have to be
// right on the first paint, and the baseline decides what that paint shows.
await initSettings();
// Started now rather than when the sheet opens: asking the OS costs a third
// of a second, and a popup that fills in after you have looked at it is a
// popup you saw the wrong answer in. Nothing waits on it.
listFonts(backend, () => settings);
if (native) {
  // Which document that is comes from `onTabs`'s first event instead -- see
  // `firstTabShown` above.
  await firstTabShown;
} else {
  // The web app's list is there before its document: a file that has to be
  // asked for again holds the load up, and the other files need not wait on it.
  if (!state.docId && openFiles?.closedAll()) {
    // Every file this tab had was closed, and a bare address would be handed the
    // document a tab last showed -- the one just closed, back as if it had not been.
    showWelcome();
  } else if (await load({ keepScroll: false })) {
    connect();
  }
}
// There is a document on screen, so the window can be shown. It was built
// hidden: a window that appears empty and fills in a moment later reads as a
// slow app even when it is not.
native?.ready();
// So the arrow keys and the space bar scroll the document straight away,
// without a click in it first — but never stealing a control's focus.
if (document.activeElement === document.body) pane.focus({ preventScroll: true });
