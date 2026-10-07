// Redline's native shell.
//
// There is less here than in the Electron shell it replaces, and the missing
// part is the interesting one: what a document is, what changed since it was
// last read, and how that is drawn are all the same JavaScript the CLI runs,
// and they run in the webview. So this process owns the things only a process
// can own -- a window, a menu, a modal panel, the disk -- and nothing else.
//
// What that leaves is roughly this file, `win.rs` and `menu.rs` for the native
// side of the app, `host.rs` for the page's route to the disk, and `prefs.rs`
// for the little that has to outlive a window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, DragDropEvent, Manager, RunEvent, WindowEvent};

mod cmds;
mod host;
mod menu;
mod prefs;
mod win;

/// The files named on a command line, in order -- several of them open as tabs
/// of one window.
///
/// `cwd` is a parameter rather than read here because of the second-instance
/// case: that command line was typed in another shell, so a relative path in it
/// means something different than it would here. Symlinks are deliberately left
/// alone, so that a link and its target stay one document with one history --
/// the same choice the node build makes.
fn files_from_args(argv: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    argv.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-') && a != ".")
        .map(|a| {
            let p = PathBuf::from(&a);
            if p.is_absolute() { p } else { cwd.join(p) }
        })
        .filter(|p| p.is_file())
        .collect()
}

/// Whether the first window has been decided on yet.
///
/// A file double-clicked in Finder does not arrive as an argument: it comes as
/// an Opened event. Either route may be first, so both go through here and the
/// loser finds there is nothing left to do.
static STARTED: AtomicBool = AtomicBool::new(false);

/// Files from Finder that arrived before there was anywhere to put them.
///
/// The Opened event does not come a moment *after* launch -- on a cold launch
/// it comes during it, and before the hook that sets this app up. macOS sends
/// `application:openURLs:` from inside `-[NSApplication finishLaunching]`,
/// which is earlier than the did-finish-launching notification Tauri runs
/// `setup` on. So the very first thing a double-clicked document did was reach
/// `arrive` with no managed state to read, and `State::get` panics -- which
/// under `panic = "abort"` is the app dying before it drew anything. Every
/// double-click and every `open doc.md` on a Redline that was not already
/// running, silently, with only a crash report to show for it.
///
/// So park them. `setup` collects them a few milliseconds later and treats
/// them exactly as it treats a command line.
static PENDING: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Put the first window up, on these files or on what was open last.
fn start(app: &AppHandle, files: Vec<PathBuf>) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    // Nothing asked for: carry on where you left off, and only ask when there
    // is nothing to carry on from.
    let (files, active) = match (files.is_empty(), win::prefs(app).reopen_last()) {
        (true, true) => win::prefs(app).session(),
        _ => (files, None),
    };
    if files.is_empty() {
        // The panel, and if it is dismissed there is no document, no window and
        // so nothing for the app to be -- `prompt` quits.
        return cmds::prompt(app.clone(), None, false);
    }
    win::create_window(app, &files, active.as_deref());
}

/// A file arriving at an app that is already up: from Finder, from a dropped
/// dock icon, or from another `redline doc.md` in a terminal.
fn arrive(app: &AppHandle, files: &[PathBuf]) {
    // ...or at an app that is not up yet, which is the usual case for a
    // double-click: nothing below here can run without the shell's state, so
    // the files wait for it rather than taking the process down. See PENDING.
    if app.try_state::<win::Shell>().is_none() {
        PENDING.lock().unwrap().extend(files.iter().cloned());
        return;
    }
    if files.is_empty() {
        // A bare second launch: bring what is already open forward instead.
        if let Some(w) = win::front(app).and_then(|l| app.get_webview_window(&l)) {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        return;
    }
    // Arrived before the first window was decided on, which means this *is*
    // the launch: a double-clicked file gets a window of its own either way.
    if !STARTED.load(Ordering::SeqCst) {
        return start(app, files.to_vec());
    }
    // Where a file from Finder lands is a setting, because both answers are
    // reasonable: a tab keeps one window to look after, a window lets two
    // documents sit side by side.
    if win::prefs(app).finder_opens_in_window() {
        for file in files {
            if win::window_for(app, file).is_none() {
                win::create_window(app, std::slice::from_ref(file), None);
            } else {
                win::open_file(app, file, None);
            }
        }
    } else {
        win::open_batch(app, files, None);
    }
}

fn main() {
    tauri::Builder::default()
        // First, and before any window: a second copy of the app should hand
        // its arguments over and exit, not open a second set of windows onto
        // the same documents.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = files_from_args(argv, Path::new(&cwd));
            arrive(app, &files);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            // The page's platform adapter -- the disk, and one process.
            host::read_text,
            host::write_text,
            host::mkdirp,
            host::read_dir,
            host::remove,
            host::rename,
            host::exists,
            host::modified,
            host::spawn,
            // The page's shell -- windows, tabs, panels, preferences.
            cmds::open_paths,
            cmds::pick_file,
            cmds::tabs,
            cmds::select_tab,
            cmds::close_tab,
            cmds::settings,
            cmds::set_settings,
            cmds::reveal,
            cmds::open_external,
            cmds::check_update,
            cmds::ready,
            // Debug builds only, in effect: see cmds::menu.
            cmds::menu,
        ])
        .on_menu_event(|app, event| menu::dispatch(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let label = window.label();
            match event {
                // Which window a menu command means: whoever was in front when
                // it was chosen.
                WindowEvent::Focused(true) => win::note_front(app, label),
                WindowEvent::Moved(_) => win::save_bounds(app, label),
                WindowEvent::Resized(_) => {
                    win::save_bounds(app, label);
                    // The only event a fullscreen transition reliably produces.
                    win::check_fullscreen(app, label);
                }
                WindowEvent::Destroyed => win::forget_window(app, label),
                // The webview never sees a dropped file -- the process that
                // owns the window does -- so the page is told when to show its
                // drop affordance and this side does the opening.
                WindowEvent::DragDrop(drag) => match drag {
                    DragDropEvent::Enter { paths, .. } if paths.iter().any(|p| p.is_file()) => {
                        win::show_drop(app, label, true);
                    }
                    DragDropEvent::Leave => win::show_drop(app, label, false),
                    DragDropEvent::Drop { paths, .. } => {
                        win::show_drop(app, label, false);
                        // A drop of several files opens all of them, one tab each.
                        let files: Vec<PathBuf> =
                            paths.iter().filter(|p| p.is_file()).cloned().collect();
                        win::open_batch(app, &files, Some(label));
                    }
                    _ => {}
                },
                _ => {}
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(win::Shell::new(prefs::Prefs::open(&handle)));
            menu::install(&handle)?;
            cmds::apply_settings(&handle);

            let cwd = std::env::current_dir().unwrap_or_default();
            let mut files = files_from_args(std::env::args(), &cwd);

            // A document opened from Finder is not on a command line, and by
            // now it is not on its way either -- it is already waiting. Taken
            // after the arguments and without the duplicates, since `redline
            // doc.md` from a terminal can name the same file both ways.
            for file in PENDING.lock().unwrap().drain(..) {
                if !files.contains(&file) {
                    files.push(file);
                }
            }

            // Given a file, start on it. Given none, wait a moment first: an
            // Opened event can still land after this hook -- "Open With" on an
            // app that is mid-launch -- and opening the panel before it does
            // would be the wrong answer arriving faster than the right one.
            if !files.is_empty() || !cfg!(target_os = "macos") {
                start(&handle, files);
            } else {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    let _ = handle.clone().run_on_main_thread(move || start(&handle, vec![]));
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Redline failed to start")
        .run(|app, event| match event {
            // Finder's "Open With", and a file dropped on the dock icon.
            RunEvent::Opened { urls } => {
                let files: Vec<PathBuf> =
                    urls.iter().filter_map(|u| u.to_file_path().ok()).collect();
                arrive(app, &files);
            }
            // Belt and braces: the session is written on every tab change
            // already, so by now there is nothing new to say -- unless the app
            // is being quit with windows still up.
            RunEvent::ExitRequested { .. } => win::remember_session(app),
            _ => {}
        });
}
