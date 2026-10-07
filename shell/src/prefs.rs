// One small file, remembered between launches.
//
//   window.json  { x, y, width, height, alwaysOnTop, lastDir, recent,
//                  session: { files, active }, settings: { ... } }
//
// Everything in here is a convenience rather than data: losing it costs the
// window's position and the folder the open panel starts in, and nothing a
// reader wrote. So every failure is swallowed -- a corrupt or unreadable copy
// means the defaults, and a write that does not land is not worth interrupting
// anyone over.
//
// Note what is not here: the defaults for the settings themselves. Those live
// in public/app.js, which is the one place that knows what all of them mean;
// this stores whatever the page sends and reads the three keys the shell itself
// has to act on.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Map, Value};

pub struct Prefs {
    file: PathBuf,
    /// Held in memory as well as on disk, so that a window being dragged is not
    /// a file being parsed sixty times a second.
    held: Mutex<Value>,
}

impl Prefs {
    pub fn open(app: &tauri::AppHandle) -> Self {
        use tauri::Manager;
        let dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
        let file = dir.join("window.json");
        let held = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        Self { file, held: Mutex::new(held) }
    }

    pub fn get(&self, key: &str) -> Value {
        self.held.lock().unwrap().get(key).cloned().unwrap_or(Value::Null)
    }

    /// Merged rather than replaced, so that saving the window's bounds does not
    /// forget the open folder.
    pub fn merge(&self, patch: Value) {
        let mut held = self.held.lock().unwrap();
        if let (Some(into), Some(from)) = (held.as_object_mut(), patch.as_object()) {
            for (k, v) in from {
                into.insert(k.clone(), v.clone());
            }
        }
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string(&*held) {
            let _ = std::fs::write(&self.file, text);
        }
    }

    // --- settings ----------------------------------------------------------

    pub fn settings(&self) -> Value {
        match self.get("settings") {
            v @ Value::Object(_) => v,
            _ => json!({}),
        }
    }

    pub fn set_settings(&self, patch: Value) -> Value {
        let mut next = match self.settings() {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        if let Some(from) = patch.as_object() {
            for (k, v) in from {
                next.insert(k.clone(), v.clone());
            }
        }
        let next = Value::Object(next);
        self.merge(json!({ "settings": next }));
        next
    }

    /// One of the settings, as a string, with what the page would have used.
    fn setting(&self, key: &str, fallback: &str) -> String {
        self.settings()
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or(fallback)
            .to_string()
    }

    /// 'system' | 'light' | 'sepia' | 'dark' -- the only one the shell applies
    /// itself, because on macOS the window's appearance is what the webview
    /// reports to the page as prefers-color-scheme, and there is nothing to keep
    /// in step. Sepia is a light window: the cream is the page's own tint over
    /// the light palette, and pinning the chrome light is what stops a system
    /// set to dark from drawing a dark bar and dark scrollbars around it.
    pub fn appearance(&self) -> Option<tauri::Theme> {
        match self.setting("appearance", "system").as_str() {
            "light" | "sepia" => Some(tauri::Theme::Light),
            "dark" => Some(tauri::Theme::Dark),
            _ => None,
        }
    }

    /// Whether to start with the files you left open.
    pub fn reopen_last(&self) -> bool {
        self.settings().get("reopenLast").and_then(Value::as_bool).unwrap_or(true)
    }

    /// Where a file from Finder lands: 'tab' | 'window'.
    pub fn finder_opens_in_window(&self) -> bool {
        self.setting("finderOpensIn", "tab") == "window"
    }

    // --- the window ---------------------------------------------------------

    /// Where the last window to move was, if it said.
    pub fn bounds(&self) -> Option<(f64, f64, f64, f64)> {
        let p = self.held.lock().unwrap();
        let n = |k: &str| p.get(k).and_then(Value::as_f64);
        Some((n("x")?, n("y")?, n("width")?, n("height")?))
    }

    pub fn size(&self) -> (f64, f64) {
        let p = self.held.lock().unwrap();
        let n = |k: &str, d: f64| p.get(k).and_then(Value::as_f64).filter(|v| *v > 0.0).unwrap_or(d);
        (n("width", 820.0), n("height", 1000.0))
    }

    pub fn always_on_top(&self) -> bool {
        self.get("alwaysOnTop").as_bool().unwrap_or(false)
    }

    // --- where you were ----------------------------------------------------

    /// The folder the last opened file came from, if it is still a folder.
    /// Without it the open panel starts at Documents every launch, which is
    /// rarely where the documents you are reading live.
    pub fn last_dir(&self) -> Option<PathBuf> {
        let dir = PathBuf::from(self.get("lastDir").as_str()?);
        dir.is_dir().then_some(dir)
    }

    /// What was open when you last quit, minus anything since deleted or moved.
    pub fn session(&self) -> (Vec<PathBuf>, Option<PathBuf>) {
        let s = self.get("session");
        let files: Vec<PathBuf> = s
            .get("files")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(PathBuf::from)
                    .filter(|p| p.is_file())
                    .collect()
            })
            .unwrap_or_default();
        let active = s
            .get("active")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .filter(|p| files.contains(p))
            .or_else(|| files.first().cloned());
        (files, active)
    }

    pub fn save_session(&self, files: &[PathBuf], active: Option<&Path>) {
        if files.is_empty() {
            return;
        }
        self.merge(json!({ "session": {
            "files": files.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
            "active": active.map(|p| p.to_string_lossy().into_owned()),
        }}));
    }

    // --- Open Recent -------------------------------------------------------

    /// Newest first, deduplicated, capped. Kept here rather than asked of the
    /// OS: AppKit fills this menu on its own only for document-based apps, and
    /// a list in the same file as everything else is the same list on every
    /// platform.
    pub fn recent(&self) -> Vec<PathBuf> {
        self.get("recent")
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).map(PathBuf::from).collect())
            .unwrap_or_default()
    }

    pub fn note_recent(&self, file: &Path) {
        const KEEP: usize = 12;
        let mut list = self.recent();
        list.retain(|p| p != file);
        list.insert(0, file.to_path_buf());
        list.truncate(KEEP);
        self.merge(json!({
            "recent": list.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>()
        }));
    }

    /// Take a file off the list, for when opening it from the menu turns out to
    /// be impossible -- it is not coming back, so it should not be offered again.
    pub fn drop_recent(&self, file: &Path) {
        let mut list = self.recent();
        list.retain(|p| p != file);
        self.merge(json!({
            "recent": list.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>()
        }));
    }

    pub fn clear_recent(&self) {
        self.merge(json!({ "recent": [] }));
    }
}
