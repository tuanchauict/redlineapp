// Windows, and the tabs in them.
//
// A window holds a list of documents and shows one of them. The list is drawn
// by the page as a sidebar rather than by the OS as tabs, because the title bar
// is already the page's own toolbar and macOS paints its tab bar over that with
// no way to ask when it is there.
//
// The list here is a list of *paths*. That is the one real difference from the
// Electron shell this replaces, and it is what lets the reader live in the
// webview: there is no single reader for this process to ask what a document id
// means, but an id is a pure function of the absolute path, so each page works
// out the ids of its own tabs and this side never needs to know them.
//
// Which also means a window is cheap to hand a document to and cheap to take
// one from: there is no reference to pass across, because the two pages hold
// their own. Moving a tab to a new window is a close and an open.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};

use crate::host::Handoff;
use crate::prefs::Prefs;

const MIN_WIDTH: f64 = 420.0;
const MIN_HEIGHT: f64 = 300.0;
/// Offset a new window off the last one so it does not land exactly on top.
const CASCADE: f64 = 24.0;

pub const MD_EXTENSIONS: [&str; 6] = ["md", "markdown", "mdown", "mkd", "mdx", "txt"];

#[derive(Default)]
struct Win {
    tabs: Vec<PathBuf>,
    active: Option<PathBuf>,
    /// Compared on every resize, because that is the only event a fullscreen
    /// transition reliably produces and the page needs to know.
    fullscreen: bool,
    zoom: f64,
}

pub struct Shell {
    pub prefs: Prefs,
    wins: Mutex<HashMap<String, Win>>,
    /// Which window a menu command means. Tracked rather than asked, because
    /// the menu fires after the click and the answer has to be who was in front
    /// when it did.
    front: Mutex<Option<String>>,
    next: Mutex<u32>,
    /// Set once, so exactly one window a launch sweeps the store.
    swept: Mutex<bool>,
}

impl Shell {
    pub fn new(prefs: Prefs) -> Self {
        Self {
            prefs,
            wins: Mutex::new(HashMap::new()),
            front: Mutex::new(None),
            next: Mutex::new(0),
            swept: Mutex::new(false),
        }
    }
}

/// The shell's own state, which every function here needs.
fn shell(app: &AppHandle) -> tauri::State<'_, Shell> {
    app.state::<Shell>()
}

/// The remembered part: where the window was, which folder the open panel
/// starts in, the settings the page sent over.
pub fn prefs(app: &AppHandle) -> &Prefs {
    &app.state::<Shell>().inner().prefs
}

/// Float the front window over the others, and remember which way it was left.
///
/// Recorded as the app's choice rather than the window's, because a new window
/// starts out matching it -- someone who wants a document beside their editor
/// wants the next one there too.
pub fn set_always_on_top(app: &AppHandle, on: bool) {
    if let Some(w) = front(app).and_then(|l| app.get_webview_window(&l)) {
        let _ = w.set_always_on_top(on);
    }
    prefs(app).merge(json!({ "alwaysOnTop": on }));
}

/// Whichever window a menu command or a Finder open should land on.
pub fn front(app: &AppHandle) -> Option<String> {
    let s = shell(app);
    let front = s.front.lock().unwrap().clone();
    match front {
        Some(label) if s.wins.lock().unwrap().contains_key(&label) => Some(label),
        // Nothing has been focused yet, or the window that was has gone.
        _ => s.wins.lock().unwrap().keys().next().cloned(),
    }
}

pub fn note_front(app: &AppHandle, label: &str) {
    *shell(app).front.lock().unwrap() = Some(label.to_string());
}

/// Which window is already showing this file, if any.
///
/// One document belongs to one window: two views of it would each keep their
/// own place in the history and only confuse what "changed" means.
pub fn window_for(app: &AppHandle, file: &Path) -> Option<String> {
    shell(app)
        .wins
        .lock()
        .unwrap()
        .iter()
        .find(|(_, w)| w.tabs.iter().any(|p| p == file))
        .map(|(label, _)| label.clone())
}

pub fn tabs_of(app: &AppHandle, label: &str) -> (Vec<PathBuf>, Option<PathBuf>) {
    let wins = shell(app).inner().wins.lock().unwrap();
    wins.get(label).map(|w| (w.tabs.clone(), w.active.clone())).unwrap_or_default()
}

pub fn active_of(app: &AppHandle, label: &str) -> Option<PathBuf> {
    shell(app).wins.lock().unwrap().get(label)?.active.clone()
}

// --- telling the page ------------------------------------------------------

/// Tell a window's page what it is holding.
///
/// The page draws the list and treats `active` as the document to show, so this
/// one message is also how a tab switch reaches the renderer. Only paths go
/// over: the page turns them into document ids, because it is the side with a
/// reader.
pub fn send_tabs(app: &AppHandle, label: &str) {
    let (tabs, active) = tabs_of(app, label);
    if tabs.is_empty() {
        return;
    }

    if let (Some(win), Some(abs)) = (app.get_webview_window(label), active.as_ref()) {
        // What the Window menu calls this window, and what a screenshot of it
        // is named. Not the proxy icon as well: that is a represented filename,
        // which this toolkit does not expose and is not worth an `unsafe` block
        // of AppKit to set.
        let _ = win.set_title(&abs.file_name().unwrap_or_default().to_string_lossy());
    }

    // Tabs changed, so the session did: this covers every add, close and switch.
    remember_session(app);

    let _ = app.emit_to(
        label,
        "md:tabs",
        json!({
            "active": active.as_ref().map(|p| p.to_string_lossy()),
            "tabs": tabs.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
        }),
    );
}

/// Tell a page a file is being dragged over it, or is not any more.
///
/// The page cannot see this for itself: the drag belongs to the window, and
/// the webview is handed the paths only once they are dropped.
pub fn show_drop(app: &AppHandle, label: &str, over: bool) {
    let _ = app.emit_to(label, "md:drag", over);
}

/// Send one of the menu's commands to whichever page is in front.
///
/// Addressing a window by name here only reaches that window if the page asked
/// to be addressed by name. `emit_to`'s filter is skipped for a listener
/// registered without a target, so a page that signs up the easy way gets every
/// window's mail -- the menu driving all the windows at once, each one's tab
/// list replacing the next one's. `src/native-tauri.js` names its own label for
/// exactly this reason; the label reaches it in the handoff.
pub fn to_front(app: &AppHandle, event: &str, payload: impl serde::Serialize + Clone) {
    if let Some(label) = front(app) {
        let _ = app.emit_to(label, event, payload);
    }
}

// --- tabs ------------------------------------------------------------------

/// Add a document to a window, or bring it forward if it is already there.
///
/// `select` off adds the tab without putting it on screen, and `after` says
/// which tab it goes to the right of -- together they let a batch arrive in
/// order and switch the document once, at the end, rather than once per file.
pub fn add_tab(
    app: &AppHandle,
    label: &str,
    file: &Path,
    select: bool,
    after: Option<&Path>,
) -> bool {
    if !file.is_file() {
        return false;
    }
    {
        let s = shell(app);
        let mut wins = s.wins.lock().unwrap();
        let Some(win) = wins.get_mut(label) else { return false };

        if win.tabs.iter().any(|p| p == file) {
            if select {
                win.active = Some(file.to_path_buf());
            }
            drop(wins);
            send_tabs(app, label);
            return true;
        }

        // Right of the one in front, the way a browser opens a tab from a page.
        let at = after
            .or(win.active.as_deref())
            .and_then(|a| win.tabs.iter().position(|p| p == a))
            .map(|i| i + 1)
            .unwrap_or(win.tabs.len());
        win.tabs.insert(at, file.to_path_buf());
        if select {
            win.active = Some(file.to_path_buf());
        }
    }
    shell(app).prefs.note_recent(file);
    crate::menu::refresh_recent(app);
    send_tabs(app, label);
    true
}

/// Add files as tabs, in order, without disturbing the tab you are reading.
pub fn add_tabs(app: &AppHandle, label: &str, files: &[PathBuf], after: Option<PathBuf>) {
    // One at a time, each to the right of the last, so they end up in the
    // order they were picked.
    let mut after = after;
    for f in files {
        if add_tab(app, label, f, false, after.as_deref()) {
            after = Some(f.clone());
        }
    }
}

pub fn select_tab(app: &AppHandle, label: &str, file: &Path) -> bool {
    {
        let s = shell(app);
        let mut wins = s.wins.lock().unwrap();
        let Some(win) = wins.get_mut(label) else { return false };
        if !win.tabs.iter().any(|p| p == file) || win.active.as_deref() == Some(file) {
            return false;
        }
        win.active = Some(file.to_path_buf());
    }
    send_tabs(app, label);
    true
}

/// Closing the last tab closes the window -- there would be nothing left to show.
pub fn close_tab(app: &AppHandle, label: &str, file: Option<&Path>) -> bool {
    let closing;
    {
        let s = shell(app);
        let mut wins = s.wins.lock().unwrap();
        let Some(win) = wins.get_mut(label) else { return false };
        let Some(target) = file.map(Path::to_path_buf).or_else(|| win.active.clone()) else {
            return false;
        };
        let Some(at) = win.tabs.iter().position(|p| *p == target) else { return false };

        if win.tabs.len() == 1 {
            closing = true;
        } else {
            win.tabs.remove(at);
            if win.active.as_deref() == Some(target.as_path()) {
                win.active = win.tabs.get(at.min(win.tabs.len() - 1)).cloned();
            }
            closing = false;
        }
    }
    if closing {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.close();
        }
    } else {
        send_tabs(app, label);
    }
    true
}

pub fn step_tab(app: &AppHandle, step: isize) {
    let Some(label) = front(app) else { return };
    let (tabs, active) = tabs_of(app, &label);
    if tabs.len() < 2 {
        return;
    }
    let at = active.and_then(|a| tabs.iter().position(|p| *p == a)).unwrap_or(0) as isize;
    let n = tabs.len() as isize;
    let next = tabs[((at + step).rem_euclid(n)) as usize].clone();
    select_tab(app, &label, &next);
}

/// Pull the front tab out into a window of its own.
///
/// A close and an open, with nothing handed between them: each page holds its
/// own reader, and the history is on disk, so there is no reference to keep
/// alive across the move.
pub fn move_tab_to_new_window(app: &AppHandle) {
    let Some(label) = front(app) else { return };
    let (tabs, active) = tabs_of(app, &label);
    let Some(abs) = active else { return };
    if tabs.len() < 2 {
        return;
    }
    close_tab(app, &label, Some(&abs));
    let _ = create_window(app, &[abs], None);
}

/// Gather every open document into the front window, one tab each.
pub fn merge_all_windows(app: &AppHandle) {
    let Some(host) = front(app) else { return };
    let others: Vec<String> = shell(app)
        .wins
        .lock()
        .unwrap()
        .keys()
        .filter(|l| **l != host)
        .cloned()
        .collect();

    for other in others {
        let (tabs, _) = tabs_of(app, &other);
        // The gathered tabs queue up behind the one you are reading, not in
        // front of it.
        let after = tabs_of(app, &host).0.last().cloned();
        add_tabs(app, &host, &tabs, after);
        if let Some(w) = app.get_webview_window(&other) {
            let _ = w.close();
        }
    }
    if let Some(w) = app.get_webview_window(&host) {
        let _ = w.set_focus();
    }
}

// --- opening ---------------------------------------------------------------

/// Open a file as a tab of the given window, or surface the window already
/// showing it.
pub fn open_file(app: &AppHandle, file: &Path, label: Option<&str>) -> bool {
    if let Some(already) = window_for(app, file) {
        if let Some(w) = app.get_webview_window(&already) {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        select_tab(app, &already, file);
        return true;
    }
    match label.map(str::to_string).or_else(|| front(app)) {
        Some(label) => add_tab(app, &label, file, true, None),
        None => create_window(app, &[file.to_path_buf()], None).is_some(),
    }
}

/// Open a batch as tabs, in order, and stay on the first of them.
///
/// Opening one file brings it to the front, which is what you want for one file
/// and not for a list: the first one named is the one you asked for, and the
/// rest join quietly behind it, so the reader loads one document rather than N.
pub fn open_batch(app: &AppHandle, files: &[PathBuf], label: Option<&str>) -> bool {
    let Some(first) = files.iter().position(|f| open_file(app, f, label)) else {
        return false;
    };
    // Wherever the first one landed -- it may have been open elsewhere already.
    if let Some(host) = window_for(app, &files[first]) {
        add_tabs(app, &host, &files[first + 1..], None);
    }
    true
}

// --- windows ---------------------------------------------------------------

/// Where a new window goes: the last remembered place, stepped off any window
/// already on screen.
fn placement(app: &AppHandle) -> (Option<(f64, f64)>, (f64, f64)) {
    let s = shell(app);
    let open = s.wins.lock().unwrap().len() as f64;
    let size = s.prefs.size();
    let at = s.prefs.bounds().map(|(x, y, _, _)| {
        let step = CASCADE * open;
        (x + step, y + step)
    });
    (at, size)
}

/// Remembered from whichever window moved last -- new windows start from it.
pub fn save_bounds(app: &AppHandle, label: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    if w.is_fullscreen().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
        return;
    }
    let Ok(scale) = w.scale_factor() else { return };
    let Ok(pos) = w.outer_position() else { return };
    let Ok(size) = w.inner_size() else { return };
    let pos = pos.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    shell(app).prefs.merge(json!({
        "x": pos.x, "y": pos.y, "width": size.width, "height": size.height,
    }));
}

/// Every open document, in window order, and the one you were reading.
///
/// Called with no windows left it does nothing, which is what makes quitting
/// work: the last window's close saves the session, and the teardown after it
/// cannot erase it.
pub fn remember_session(app: &AppHandle) {
    let s = shell(app);
    // Asked before the list is locked, because answering it reads the same list
    // and this lock is not a reentrant one: it would be waiting on itself.
    let front = front(app);
    let wins = s.wins.lock().unwrap();
    if wins.is_empty() {
        return;
    }
    let mut files: Vec<PathBuf> = Vec::new();
    for w in wins.values() {
        for p in &w.tabs {
            if !files.contains(p) {
                files.push(p.clone());
            }
        }
    }
    let active = front
        .and_then(|l| wins.get(&l).and_then(|w| w.active.clone()))
        .or_else(|| files.first().cloned());
    drop(wins);
    s.prefs.save_session(&files, active.as_deref());
}

/// Build a window on a set of documents. The first is the one on screen.
pub fn create_window(app: &AppHandle, files: &[PathBuf], active: Option<&Path>) -> Option<String> {
    let files: Vec<PathBuf> = files.iter().filter(|f| f.is_file()).cloned().collect();
    let first = files.first()?.clone();
    let active = active.map(Path::to_path_buf).filter(|a| files.contains(a)).unwrap_or(first);

    let label = {
        let s = shell(app);
        let mut n = s.next.lock().unwrap();
        *n += 1;
        format!("w{n}")
    };

    // Exactly one window a launch sweeps snapshots no document refers to any
    // more. Two at once could list the store between another window writing a
    // snapshot and recording it, and take the new one away again.
    let sweep = {
        let s = shell(app);
        let mut swept = s.swept.lock().unwrap();
        let first = !*swept;
        *swept = true;
        first
    };

    let ordered: Vec<String> = std::iter::once(&active)
        .chain(files.iter().filter(|f| **f != active))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let handoff = Handoff::new(app, &label, ordered, sweep);

    // A test harness rides along in the same script as the handoff, because the
    // page must see both or neither: one init script is one unit of injection.
    let mut first = handoff.script();
    if let Some(probe) =
        std::env::var("REDLINE_PROBE_SCRIPT").ok().and_then(|p| std::fs::read_to_string(p).ok())
    {
        first.push('\n');
        first.push_str(&probe);
    }

    let (at, (width, height)) = placement(app);
    let mut b = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Redline")
        .inner_size(width, height)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .initialization_script(&first)
        .theme(shell(app).prefs.appearance())
        // Shown once the page has something to show. A window that appears
        // empty and then fills in reads as a slow app even when it is not.
        .visible(false);

    if let Some((x, y)) = at {
        b = b.position(x, y);
    }

    #[cfg(target_os = "macos")]
    {
        // The integrated strip: no OS title bar, traffic lights floated over
        // the page's own toolbar -- the arrangement VS Code uses.
        //
        // `hidden_title` as well, and it is not optional: Overlay makes the
        // title bar transparent and lets the page under it, but macOS goes on
        // drawing the window's title in the middle of it. The title is the
        // document's name (see `send_tabs`), and the page's own bar says that
        // too -- so without this the strip reads the filename twice.
        b = b
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(13.0, 12.0));
    }

    // A window under test has to be a window someone could be looking at: a
    // webview macOS thinks is covered has its timers suspended, so an
    // off-screen one would sit there doing nothing at all.
    if std::env::var("REDLINE_PROBE").is_ok() {
        b = b
            .position(40.0, 40.0)
            .inner_size(1000.0, 760.0)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(true);
    }

    let win = b.build().ok()?;
    if shell(app).prefs.always_on_top() {
        let _ = win.set_always_on_top(true);
    }
    reveal_when_ready(&win);

    shell(app).wins.lock().unwrap().insert(
        label.clone(),
        Win { tabs: files.clone(), active: Some(active.clone()), fullscreen: false, zoom: 1.0 },
    );
    note_front(app, &label);
    for f in &files {
        shell(app).prefs.note_recent(f);
    }
    crate::menu::refresh_recent(app);
    Some(label)
}

/// Show a window once there is something in it.
///
/// Built hidden, because a window that appears empty and fills in a moment
/// later reads as a slow app even when it is not. The page says when it has
/// drawn (`cmds::ready`); this is the promise that it will be shown even if it
/// never does -- a page that fails to load should be a visible broken window
/// rather than an app that appears not to have started.
fn reveal_when_ready(win: &tauri::WebviewWindow) {
    const GRACE: std::time::Duration = std::time::Duration::from_millis(1500);
    let win = win.clone();
    std::thread::spawn(move || {
        std::thread::sleep(GRACE);
        let _ = win.show();
    });
}

/// The page has drawn. Whichever of this and the grace period is first wins;
/// showing a window twice costs nothing.
pub fn ready(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
    }
}

/// A window has gone. Its documents go with it -- the page held them, and the
/// page is gone too.
pub fn forget_window(app: &AppHandle, label: &str) {
    shell(app).wins.lock().unwrap().remove(label);
    // Closing one of several windows does narrow the session; closing the last
    // one cannot, since there would then be nothing to save.
    remember_session(app);
}

// --- fullscreen and zoom ---------------------------------------------------

/// Tell the page if the window entered or left fullscreen.
///
/// Compared rather than listened for: a fullscreen transition shows up here as
/// a resize, and the page needs to know because the traffic lights stop being
/// over its toolbar.
pub fn check_fullscreen(app: &AppHandle, label: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    let now = w.is_fullscreen().unwrap_or(false);
    let changed = {
        let s = shell(app);
        let mut wins = s.wins.lock().unwrap();
        let Some(win) = wins.get_mut(label) else { return };
        let changed = win.fullscreen != now;
        win.fullscreen = now;
        changed
    };
    if changed {
        let _ = app.emit_to(label, "md:fullscreen", now);
    }
}

/// Step the page's zoom, or put it back. The window remembers its own.
pub fn zoom(app: &AppHandle, by: Option<f64>) {
    let Some(label) = front(app) else { return };
    let next = {
        let s = shell(app);
        let mut wins = s.wins.lock().unwrap();
        let Some(win) = wins.get_mut(&label) else { return };
        win.zoom = match by {
            None => 1.0,
            Some(step) => (win.zoom + step).clamp(0.5, 3.0),
        };
        win.zoom
    };
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_zoom(next);
    }
}
