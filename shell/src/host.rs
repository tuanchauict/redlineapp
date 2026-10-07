// The disk and the process table, for a page that has neither.
//
// This is the Rust half of the Platform contract in src/platform.js. The other
// half is src/platform-tauri.js, which calls straight through to these. There
// is deliberately nothing else in here: no notion of a document, a version or a
// diff, because all of that is the reader's, and the reader runs in the webview.
//
// Everything is a plain request and answer. Notably there is no file watcher:
// the JS side polls a modification time through `modified`, which is a stat per
// open document a few times a second and costs a native dependency nothing. A
// watcher would also have to be told apart from an editor's atomic save, where
// a temp file is renamed over the top and the inode the watch was holding is no
// longer the file; a stat of the path never has that problem, because it
// follows the name rather than the inode.
//
// What is here is also everything a page can do to this machine, and the page
// draws documents written by other people. src/sanitize.js and the CSP in
// tauri.conf.json are what stop a document running script in it; the checks
// below are what a script would find if one ever did. Reading is left open --
// a reader has to follow a link to any file, and the CSP is what keeps what it
// read from leaving -- but writing is held to the shapes the store writes, and
// running a program to the four commands the reader runs.
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// What a program said. The shape src/platform.js documents as SpawnResult.
#[derive(Serialize)]
pub struct SpawnResult {
    /// Exit status, or null if it was killed -- which is how a timeout reads.
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Null rather than an error when the file is not there.
///
/// A missing snapshot is an ordinary thing in a store that can be pruned or
/// hand-tidied between one read and the next, and the reader is written to
/// expect it. Lossy UTF-8 rather than a failure for the same reason: a document
/// with one bad byte in it should still be readable.
#[tauri::command]
pub fn read_text(path: String) -> Option<String> {
    fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// Write the whole file, making its directory if need be.
///
/// Through a temp file and a rename, so that a crash or a full disk cannot
/// leave a half-written index behind: the store's own JSON is the one file
/// here that is read back and parsed, and a truncated one would lose the
/// history it is there to remember.
#[tauri::command]
pub fn write_text(app: AppHandle, path: String, text: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let ok = matches!(
        store_path(&path, &store_roots(&app)).as_deref(),
        Some([dir, name]) if plain(name)
            && ((*dir == "objects" && name.ends_with(".md"))
                || (*dir == "docs" && name.ends_with(".json")))
    );
    if !ok {
        return Err(refused("write", &path));
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut tmp = path.clone().into_os_string();
    tmp.push(".writing");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mkdirp(app: AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let ok = matches!(
        store_path(&path, &store_roots(&app)).as_deref(),
        Some([] | ["objects" | "docs"])
    );
    if !ok {
        return Err(refused("make", &path));
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

/// File names, not paths -- what the contract asks for.
#[tauri::command]
pub fn read_dir(path: String) -> Vec<String> {
    let Ok(entries) = fs::read_dir(path) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect()
}

/// Gone either way, so a file that was not there is not a failure -- and a file
/// that is not a snapshot is not removed, which the store never asks for: the
/// sweep deletes objects and nothing else.
#[tauri::command]
pub fn remove(app: AppHandle, path: String) {
    let path = PathBuf::from(path);
    if matches!(
        store_path(&path, &store_roots(&app)).as_deref(),
        Some(["objects", name]) if plain(name)
    ) {
        let _ = fs::remove_file(path);
    }
}

/// Whether it worked. Used once, to move a store left under the app's old name,
/// and so allowed for exactly that move and no other.
#[tauri::command]
pub fn rename(app: AppHandle, from: String, to: String) -> bool {
    let Ok(home) = app.path().home_dir() else {
        return false;
    };
    if Path::new(&from) != home.join(".md-reader") || Path::new(&to) != home.join(".redline") {
        return false;
    }
    fs::rename(from, to).is_ok()
}

#[tauri::command]
pub fn exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// Last-modified time in milliseconds, or null if the file is not there.
///
/// Milliseconds as a float, because this is what the JS side polls to notice a
/// change and what it reports as a document's date; a whole-second resolution
/// would miss a file saved twice in the same second.
#[tauri::command]
pub fn modified(path: String) -> Option<f64> {
    let t = fs::metadata(path).ok()?.modified().ok()?;
    Some(t.duration_since(UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0)
}

/// Run a program to completion.
///
/// git and the PlantUML jar, both of which are the host's to find: they are on
/// a PATH the webview has never heard of. A non-zero exit resolves rather than
/// failing, because both callers want to read what was said either way -- git
/// answering "not a repository" and the jar refusing a diagram are answers.
///
/// Only the command lines the reader builds are run: see `may_spawn`.
#[tauri::command]
pub async fn spawn(
    cmd: String,
    args: Vec<String>,
    cwd: Option<String>,
    input: Option<String>,
    timeout: Option<u64>,
) -> Result<SpawnResult, String> {
    let jar = std::env::var("PLANTUML_JAR").ok();
    if !may_spawn(&cmd, &args, jar.as_deref()) {
        return Err(format!("{cmd}: refused -- not a command Redline runs"));
    }
    // On a blocking thread rather than this one: the jar can take seconds, and
    // the webview's other calls -- the store, the file poll -- have to keep
    // being answered while a page full of diagrams draws.
    tauri::async_runtime::spawn_blocking(move || {
        let mut c = Command::new(&cmd);
        c.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = cwd {
            c.current_dir(dir);
        }

        let mut child = c.spawn().map_err(|e| format!("{cmd}: {e}"))?;

        // Always closed, even when there is nothing to send: PlantUML reads
        // stdin to the end before it draws, so a pipe left open is a hang.
        if let Some(mut stdin) = child.stdin.take() {
            if let Some(text) = &input {
                let _ = stdin.write_all(text.as_bytes());
            }
        }

        // A deadline rather than a plain wait. `wait_with_output` would read
        // both pipes to the end first, so the timeout has to be able to kill a
        // program that is still holding them.
        if let Some(ms) = timeout {
            let deadline = SystemTime::now() + Duration::from_millis(ms);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Err(e) => return Err(e.to_string()),
                    Ok(None) => {}
                }
                if SystemTime::now() >= deadline {
                    let _ = child.kill();
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        Ok(SpawnResult {
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- what the page may ask for -------------------------------------------

/// Where the store can be: src/store.js's `storeRoot`, which takes
/// REDLINE_HOME when it is set and `~/.redline` otherwise, plus the old name it
/// is moved from. All three, whichever is in use -- the page only ever writes
/// to one of them, and allowing the others gives it nothing it could not reach.
///
/// The environment is the shell's own rather than anything the page sent: the
/// page's copy came from here, in the handoff, but a script could change it.
fn store_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = std::env::var_os("REDLINE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .into_iter()
        .collect();
    if let Ok(home) = app.path().home_dir() {
        roots.push(home.join(".redline"));
        roots.push(home.join(".md-reader"));
    }
    roots
}

/// The names under a store root that lead to `path`, or None if it is not
/// under one.
///
/// Compared by component and not by string, so `~/.redline-other` is not inside
/// `~/.redline`; and refused outright if what follows the root has a `..` in
/// it, which would match the prefix and then walk back out of it. Lexical, with
/// no canonicalizing, because nothing the page can do makes a symlink.
fn store_path<'a>(path: &'a Path, roots: &[PathBuf]) -> Option<Vec<&'a str>> {
    let rest = roots.iter().find_map(|r| path.strip_prefix(r).ok())?;
    rest.components()
        .map(|c| match c {
            Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .collect()
}

/// A file name the store would make: a hash or a key and its extension. Never
/// hidden, so the temp file `write_text` leaves for an instant is not one.
fn plain(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.')
}

fn refused(what: &str, path: &Path) -> String {
    format!("refused to {what} {} -- not in the snapshot store", path.display())
}

/// The script src/fonts.js hands osascript, byte for byte -- the test suite
/// compares the two. A JXA script is a program, so this is the only one run.
const LIST_FAMILIES: &str = r#"ObjC.import("AppKit");$.NSFontManager.sharedFontManager.availableFontFamilies.js.map(s => s.js).join("\n")"#;

/// The arguments src/plantuml.js passes every renderer, after the jar.
const PLANTUML_ARGS: [&str; 4] = ["-tsvg", "-pipe", "-charset", "UTF-8"];

/// Whether `cmd args` is one of the command lines the reader builds.
///
/// Shapes rather than program names, because a program name is not enough:
/// `git -c core.sshCommand=...` runs whatever it likes, and so does `java -jar`
/// with any jar. Each arm is one call site in src/ --
///
///   git       src/git.js: the file's repo, its log, and a version out of it.
///             Everything the page chooses -- a file name, a revision -- has
///             to sit where git reads it as a name and not as an option.
///   osascript src/fonts.js: the font list, and only that script.
///   java      src/plantuml.js: a jar named plantuml.jar, or the one
///             PLANTUML_JAR names in the shell's own environment.
///   plantuml  src/plantuml.js: the launcher Homebrew installs, by absolute
///             path, because that is how the reader finds it on PATH.
///
/// A new spawn in src/ needs an arm here, or it fails in the app and works in
/// the browser -- which is what the test that greps for spawn calls is for.
fn may_spawn(cmd: &str, args: &[String], plantuml_jar: Option<&str>) -> bool {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let name = |s: &str| !s.is_empty() && !s.starts_with('-');
    match cmd {
        "git" => match a.as_slice() {
            ["ls-files", "--full-name", "--error-unmatch", "--", _] => true,
            ["rev-parse", "--show-toplevel"] => true,
            ["show", spec] => name(spec),
            ["log", count, "--follow", "--name-only", format, "--", _] => {
                count
                    .strip_prefix("--max-count=")
                    .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
                    && *format == "--format=%x00%H\x1f%at\x1f%s"
            }
            _ => false,
        },
        "osascript" => a == ["-l", "JavaScript", "-e", LIST_FAMILIES],
        "java" => match a.as_slice() {
            ["-jar", jar, rest @ ..] => {
                rest == PLANTUML_ARGS
                    && (Some(*jar) == plantuml_jar
                        || (Path::new(jar).is_absolute()
                            && Path::new(jar).file_name().is_some_and(|f| f == "plantuml.jar")))
            }
            _ => false,
        },
        _ => {
            let p = Path::new(cmd);
            p.is_absolute() && p.file_name().is_some_and(|f| f == "plantuml") && a == PLANTUML_ARGS
        }
    }
}

/// Everything the page needs before it can ask anything.
///
/// The webview cannot call in here synchronously, and the contract has `os`,
/// `env` and the path helpers as synchronous -- a store key built by awaiting a
/// separator would be a strange thing to write. So these are handed over at
/// window creation, as a literal in an initialization script, and the JS side
/// reads them from a global instead of asking.
///
/// This global is also what tells the page which of the two things it is
/// running in: public/backend.js branches on its presence, and loads the
/// reader instead of talking to a server when it is there.
#[derive(Serialize)]
pub struct Handoff {
    pub os: &'static str,
    pub home: String,
    pub env: std::collections::HashMap<String, String>,
    /// Which window this page *is* -- `w1`, `w2`. The page needs it to say what
    /// it wants to hear: a `listen` with no target registers for every event in
    /// the app, including the ones another window was addressed by name, so
    /// without this a second window's tab list lands in this one. See the
    /// `label` note in src/native-tauri.js.
    pub label: String,
    /// What this copy is, for the About row in Settings. Off the bundle the
    /// app was built as -- tauri.conf.json -- which is also what Finder's Get
    /// Info and the dmg's filename say, so all three agree by construction.
    pub version: String,
    /// Every document this window holds, and which of them is on screen.
    pub files: Vec<String>,
    pub active: Option<String>,
    /// Whether this window is the one that should sweep the store on the way
    /// up. Exactly one window a launch gets it: two sweeps at once could take
    /// away a snapshot another window had written but not yet recorded.
    pub gc: bool,
}

/// The few variables the reader actually reads, and nothing else.
///
/// Named one by one rather than handed over wholesale: the environment of a
/// desktop process holds things that are nobody's business, and a webview is
/// the last place to put them. PATH is here because finding git and the
/// PlantUML jar is what it is for.
const WANTED: [&str; 4] = ["PATH", "PATHEXT", "REDLINE_HOME", "PLANTUML_JAR"];

impl Handoff {
    /// Asked of the app rather than of the environment.
    ///
    /// A bundle launched from Finder inherits almost none of a shell's
    /// environment, so $HOME can simply be absent -- and the store lives under
    /// home, so getting this wrong would not fail, it would quietly build a
    /// second store somewhere nobody is looking. Tauri's resolver asks the OS.
    pub fn new(app: &AppHandle, label: &str, files: Vec<String>, gc: bool) -> Self {
        Self {
            label: label.to_string(),
            os: if cfg!(target_os = "macos") {
                "darwin"
            } else if cfg!(target_os = "windows") {
                "win32"
            } else {
                "linux"
            },
            home: app
                .path()
                .home_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            env: WANTED
                .iter()
                .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v)))
                .collect(),
            version: app.package_info().version.to_string(),
            active: files.first().cloned(),
            files,
            gc,
        }
    }

    /// The one line that runs before the page does.
    ///
    /// Built with serde rather than by formatting, because a Windows path is
    /// full of backslashes and a file name can hold a quote: this is JS source
    /// being written from strings the user chose, and the only safe way to do
    /// that is to let a JSON encoder do it.
    pub fn script(&self) -> String {
        let json = serde_json::to_string(self).unwrap_or_else(|_| "{}".into());
        format!("window.__REDLINE_HOST = {json};")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    /// `-jar <jar>` and what every renderer is given after it.
    fn java(jar: &str) -> Vec<&str> {
        let mut a = vec!["-jar", jar];
        a.extend(PLANTUML_ARGS);
        a
    }

    #[test]
    fn spawns_what_the_reader_runs() {
        let ok = |cmd: &str, a: &[&str]| may_spawn(cmd, &args(a), Some("/opt/my/pu.jar"));
        assert!(ok("git", &["ls-files", "--full-name", "--error-unmatch", "--", "a.md"]));
        assert!(ok("git", &["rev-parse", "--show-toplevel"]));
        assert!(ok("git", &["show", "HEAD:docs/a.md"]));
        let log = "--format=%x00%H\x1f%at\x1f%s";
        assert!(ok("git", &["log", "--max-count=9", "--follow", "--name-only", log, "--", "a.md"]));
        assert!(ok("osascript", &["-l", "JavaScript", "-e", LIST_FAMILIES]));
        assert!(ok("java", &java("/opt/homebrew/opt/plantuml/libexec/plantuml.jar")));
        assert!(ok("java", &java("/opt/my/pu.jar")));
        assert!(ok("/opt/homebrew/bin/plantuml", &PLANTUML_ARGS));
    }

    #[test]
    fn refuses_anything_else() {
        let ok = |cmd: &str, a: &[&str]| may_spawn(cmd, &args(a), None);
        assert!(!ok("sh", &["-c", "id"]));
        assert!(!ok("/bin/sh", &["-c", "id"]));
        assert!(!ok("git", &["-c", "core.sshCommand=id", "rev-parse", "--show-toplevel"]));
        assert!(!ok("git", &["show", "--output=/tmp/x"]));
        assert!(!ok("git", &["log", "--max-count=1;", "--follow", "--name-only", "x", "--", "a"]));
        assert!(!ok("osascript", &["-l", "JavaScript", "-e", "doShellScript('id')"]));
        assert!(!ok("java", &java("/tmp/evil.jar")));
        assert!(!ok("java", &java("plantuml.jar")));
        let mut more = java("/x/plantuml.jar");
        more.push("-o");
        assert!(!ok("java", &more));
        assert!(!ok("plantuml", &PLANTUML_ARGS));
        assert!(!ok("/tmp/plantuml", &["-version"]));
    }

    #[test]
    fn writes_only_into_the_store() {
        let roots = [PathBuf::from("/Users/a/.redline"), PathBuf::from("/Users/a/.md-reader")];
        let at = |p: &'static str| store_path(Path::new(p), &roots);
        assert_eq!(at("/Users/a/.redline/objects/ab12.md"), Some(vec!["objects", "ab12.md"]));
        assert_eq!(at("/Users/a/.redline/docs/k.json"), Some(vec!["docs", "k.json"]));
        assert_eq!(at("/Users/a/.redline"), Some(vec![]));
        assert_eq!(at("/Users/a/.redline/../.zshrc"), None);
        assert_eq!(at("/Users/a/.redline/objects/../../.zshrc"), None);
        assert_eq!(at("/Users/a/.redline-other/objects/x.md"), None);
        assert_eq!(at("/Users/a/.zshrc"), None);
        assert!(!plain(".hidden.md"));
    }
}
