// What the page asks of the shell.
//
// These are the other half of `window.mdNative`: the page drives its own tab
// rows, its own settings panel and its own open button, and each of those ends
// up here. The names and shapes match the Electron preload one for one, because
// public/app.js is shared and was written against it.
//
// Everything about a *document* is missing from this list on purpose -- that
// all happens in the page now, in the reader. What is left is the handful of
// things only a native process can do: put a window up, put a panel up, and
// remember something after the window has gone.
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Webview};
use tauri_plugin_dialog::DialogExt;

use crate::win::{self, MD_EXTENSIONS};

/// The window a call came from.
///
/// Taken from the webview rather than passed in by the page: a window's label
/// is not the page's business, and a page cannot claim to be a window it is not.
fn label(from: &Webview) -> String {
    from.window().label().to_string()
}

// --- documents in windows --------------------------------------------------

#[tauri::command]
pub fn open_paths(app: AppHandle, from: Webview, paths: Vec<String>) {
    let files: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    win::open_batch(&app, &files, Some(&label(&from)));
}

#[tauri::command]
pub fn pick_file(app: AppHandle, from: Webview) {
    prompt(app, Some(label(&from)), false);
}

/// Asked for by the page once it is listening: the window is built before the
/// page's modules have parsed, so the first push would land on no one.
#[tauri::command]
pub fn tabs(app: AppHandle, from: Webview) {
    win::send_tabs(&app, &label(&from));
}

#[tauri::command]
pub fn select_tab(app: AppHandle, from: Webview, path: String) {
    win::select_tab(&app, &label(&from), Path::new(&path));
}

#[tauri::command]
pub fn close_tab(app: AppHandle, from: Webview, path: Option<String>) {
    win::close_tab(&app, &label(&from), path.as_deref().map(Path::new));
}

/// The page has something on screen, so the window can be shown.
///
/// A window is built hidden and revealed from here, which is why the app does
/// not flash an empty frame on launch the way a webview usually does.
#[tauri::command]
pub fn ready(app: AppHandle, from: Webview) {
    win::ready(&app, &label(&from));
}

// --- settings --------------------------------------------------------------

#[tauri::command]
pub fn settings(app: AppHandle) -> Value {
    win::prefs(&app).settings()
}

#[tauri::command]
pub fn set_settings(app: AppHandle, patch: Value) -> Value {
    let next = win::prefs(&app).set_settings(patch);
    apply_settings(&app);
    // Every window, not just the one that changed it: one app, one preference.
    let _ = app.emit("md:settings", next.clone());
    next
}

/// The part the shell owns -- the page reads the rest for itself.
///
/// A window's appearance is what its webview reports to the page as
/// prefers-color-scheme, so setting it here sets it for the stylesheets too,
/// with nothing to keep in step: the window, the document and the highlighting
/// all follow the one switch.
pub fn apply_settings(app: &AppHandle) {
    let theme = win::prefs(app).appearance();
    for (_, w) in app.webview_windows() {
        let _ = w.set_theme(theme);
    }
}

// --- the disk, as a person sees it -----------------------------------------

/// Show a file or folder where it lives. Used for the document itself and for
/// the store, from the settings panel.
#[tauri::command]
pub fn reveal(app: AppHandle, path: String) {
    use tauri_plugin_opener::OpenerExt;
    let p = PathBuf::from(&path);
    // A folder is opened; a file is shown in the folder that holds it, with the
    // file selected. Revealing a folder would open its parent, which is not
    // what a Reveal button on a store root means.
    let _ = if p.is_dir() {
        app.opener().open_path(path, None::<&str>)
    } else {
        app.opener().reveal_item_in_dir(p)
    };
}

/// A link out of the document.
///
/// The page catches these itself rather than letting the webview navigate,
/// because there is one document in this window and going somewhere else would
/// leave nothing to come back to.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) {
    use tauri_plugin_opener::OpenerExt;
    // Only the schemes a document can legitimately point at. A markdown link is
    // untrusted text, and `file:` or a helper's own scheme would hand it more
    // than a browser would give a page.
    if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

// --- the one request out ---------------------------------------------------

/// Where the newest release says what it is. The Bundle workflow attaches a
/// `latest.json` to every release, and GitHub answers this URL with a redirect
/// to the one on whichever release is marked Latest -- which the workflow
/// marks last, once the dmg and the cask it names are both in place, so a copy
/// told about a version can always get it, by either route. `--location`
/// below is what follows the redirect.
///
/// Copies up to 0.5.0 read `dl.iamtuna.org/redline/latest.json` instead, from
/// when releases went to R2. That file is replaced by hand, once, with one
/// naming the first release published here, and left there for good: an
/// old copy is told about that one, and the copy it upgrades to asks here.
const LATEST: &str = "https://github.com/tuanchauict/redlineapp/releases/latest/download/latest.json";

#[derive(serde::Serialize)]
pub struct Update {
    current: String,
    latest: String,
    newer: bool,
    url: String,
    /// Installed by Homebrew, so the upgrade has to go through Homebrew too.
    brew: bool,
}

/// Whether there is a newer Redline than this one -- asked only from Settings
/// or Check for Updates…, never on a timer and never on launch.
///
/// This is the only request the app makes to anywhere but this machine, which
/// is why it is spelled out: a GET for a static file, with no identifier, no
/// query string and nothing about the documents in it. Someone asked, so the
/// app went and looked; nothing goes out that they did not ask for.
///
/// Over `/usr/bin/curl` rather than an HTTP crate: it is on every Mac, it is
/// one request a session at most, and a client library would be the largest
/// dependency in the shell for the smallest feature. Async, and off the main
/// thread, because a sync command runs on the main thread and a slow network
/// would freeze every window for as long as `--max-time` allows.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Update, String> {
    let current = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let out = std::process::Command::new("/usr/bin/curl")
            .args(["--fail", "--silent", "--show-error", "--location", "--max-time", "10", LATEST])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        let manifest: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
        let latest = manifest["version"].as_str().ok_or("latest.json names no version")?;
        // Handed to open_external, which takes any https link; this one should
        // only ever be the dmg, and anything else is not worth a button.
        let url = manifest["url"].as_str().filter(|u| u.starts_with("https://")).unwrap_or("");
        Ok(Update {
            newer: newer(latest, &current),
            latest: latest.to_string(),
            current,
            url: url.to_string(),
            brew: from_homebrew(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `0.10.0` is after `0.9.1`, which a string comparison gets wrong. Anything
/// after a `-` is dropped: a release is never a pre-release, so a copy built
/// as one is as new as the version it is a pre-release of.
fn newer(latest: &str, current: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> {
        let core = v.split('-').next().unwrap_or("");
        core.split('.').map(|n| n.parse().unwrap_or(0)).collect()
    };
    parts(latest) > parts(current)
}

/// Whether this copy came from `brew install --cask`.
///
/// Not from where the app is: a cask *moves* the bundle into /Applications, so
/// a Homebrew copy and a dragged one sit at the same path. What a cask leaves
/// behind is its Caskroom entry, under whichever prefix this Mac's Homebrew
/// uses. Getting this wrong matters -- a Homebrew copy replaced from a dmg
/// leaves the cask believing the old version is installed -- so it errs on
/// the side of brew, which is the advice that cannot do harm.
fn from_homebrew() -> bool {
    ["/opt/homebrew/Caskroom/redline", "/usr/local/Caskroom/redline"]
        .iter()
        .any(|p| Path::new(p).is_dir())
}

/// Run a menu command as if it had been chosen from the menu bar.
///
/// A door for the test harness, and only open in a debug build. A menu is the
/// one part of an app that cannot be driven from inside its own window: it
/// belongs to the system, and reaching it from outside needs the accessibility
/// permissions a person grants by hand. Rather than leave every menu command
/// untested, the harness names the same ids the menu items carry -- so what is
/// exercised is the real dispatch, not a copy of it.
#[tauri::command]
pub fn menu(app: AppHandle, id: String) {
    if cfg!(debug_assertions) {
        crate::menu::dispatch(&app, &id);
    }
}

// --- the open panel --------------------------------------------------------

/// Ask for files, and put them where the caller said.
///
/// `into` is the window they should join, or None for a window of their own.
/// The panel is asynchronous by necessity -- it is a modal sheet and the event
/// loop has to keep running underneath it -- so this returns immediately and
/// the documents arrive later.
pub fn prompt(app: AppHandle, into: Option<String>, new_window: bool) {
    let start = win::prefs(&app).last_dir();
    let mut dialog = app
        .dialog()
        .file()
        .set_title(if new_window { "Open in New Window" } else { "Open" })
        .add_filter("Markdown", &MD_EXTENSIONS);
    if let Some(dir) = start {
        dialog = dialog.set_directory(dir);
    }

    let app = app.clone();
    dialog.pick_files(move |picked| {
        let files: Vec<PathBuf> = picked
            .unwrap_or_default()
            .into_iter()
            .filter_map(|f| f.into_path().ok())
            .collect();
        let Some(first) = files.first() else {
            // Dismissed. With no window open this was the launch panel, and
            // there is no document, no window and so nothing for the app to be.
            if app.webview_windows().is_empty() {
                app.exit(0);
            }
            return;
        };

        // Where the panel starts next time. The folder you are reading from is
        // a better guess than Documents, which is rarely where it is.
        if let Some(dir) = first.parent() {
            win::prefs(&app).merge(serde_json::json!({
                "lastDir": dir.to_string_lossy(),
            }));
        }

        if new_window {
            win::create_window(&app, &files, None);
        } else {
            win::open_batch(&app, &files, into.as_deref());
        }
    });
}
