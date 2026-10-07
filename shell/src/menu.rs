// The app menu.
//
// Two kinds of item are in here, and the difference is worth knowing when
// reading `dispatch`: some commands are about the window or the process and are
// carried out here, and some are about the document, which this side knows
// nothing about -- those are forwarded to whichever page is in front and it
// does the work. The keyboard shortcut is the reason they are in a menu at all
// rather than only in the page: a shortcut has to work with the focus anywhere,
// including on a scrollbar or a native panel, and only the menu bar gets those.
//
// Rebuilt whole whenever Open Recent changes. A menu is cheap and the
// alternative -- holding submenu handles in shared state and mutating them from
// whichever thread a file arrived on -- is not, on a platform where menus
// belong to the main thread.
use std::path::{Path, PathBuf};

use tauri::menu::{AboutMetadata, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager};

use crate::{cmds, win};

/// Print `w`'s page with a real one-inch margin.
///
/// wry's own `print()` -- which this used to call directly -- always forces
/// `NSPrintInfo`'s margins to zero before handing the webview to
/// `-[WKWebView printOperationWithPrintInfo:]`. That would be fine if `@page`
/// CSS could make up the difference, but it can't: WebKit's print pagination
/// decides how much content fits on a page from `NSPrintInfo`'s margins, not
/// from `@page`, which only shifts where a page's content is drawn once that
/// decision is made. Zero margin in one and one inch in the other means every
/// page is paginated as if it had no margin and then drawn as if it did,
/// which is what ran the bottom of every page off the sheet. Tauri exposes no
/// way to set a real margin through its own `print()`, so this reimplements
/// wry's call with a real one instead of a forced zero -- see
/// docs/reading.md#printing.
#[cfg(target_os = "macos")]
fn print_window(w: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSPrintInfo, NSWindow};
    use objc2_web_kit::WKWebView;

    let Ok(ns_window) = w.ns_window() else { return };
    // A raw pointer is not `Send`, and `with_webview` requires it of the
    // closure below; the address itself crosses threads without trouble since
    // it is only ever dereferenced on the main thread the webview lives on.
    let ns_window = ns_window as usize;
    let _ = w.with_webview(move |platform_webview| {
        // Safety: Tauri hands back the window's own live WKWebView/NSWindow
        // pointers; retaining them only keeps this closure's reference alive,
        // it does not take ownership away from the window that owns them.
        let webview = unsafe {
            objc2::rc::Retained::retain(platform_webview.inner() as *mut WKWebView)
        };
        let window_ptr = ns_window as *mut std::ffi::c_void as *mut NSWindow;
        let window = unsafe { objc2::rc::Retained::retain(window_ptr) };
        let (Some(webview), Some(window)) = (webview, window) else { return };

        let print_info = NSPrintInfo::sharedPrintInfo();
        print_info.setTopMargin(72.0);
        print_info.setRightMargin(72.0);
        print_info.setBottomMargin(72.0);
        print_info.setLeftMargin(72.0);

        // Safety: `print_info` is a plain NSPrintInfo and `window` is the
        // webview's own window, which is exactly what this call asks for.
        unsafe {
            let operation = webview.printOperationWithPrintInfo(&print_info);
            operation.setCanSpawnSeparateThread(true);
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &window,
                None,
                None,
                std::ptr::null_mut(),
            );
        }
    });
}

/// wry's forced-zero-margin `print()`, kept for the platforms the margin bug
/// above is specific to WebKit's print pipeline -- not reimplemented here.
#[cfg(not(target_os = "macos"))]
fn print_window(w: &tauri::WebviewWindow) {
    let _ = w.print();
}

/// A path as someone would say it: `~/Projects/atlas/docs`.
fn home_relative(app: &AppHandle, dir: &Path) -> String {
    let home = app.path().home_dir().ok();
    match home.and_then(|h| dir.strip_prefix(h).ok().map(Path::to_path_buf)) {
        Some(rest) if rest.as_os_str().is_empty() => "~".into(),
        Some(rest) => format!("~/{}", rest.display()),
        None => dir.display().to_string(),
    }
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let mac = cfg!(target_os = "macos");

    let settings = MenuItemBuilder::with_id("settings", if mac { "Settings…" } else { "Preferences…" })
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    // Beside About, where a Mac app keeps it. The check is only ever made
    // from here or from the button it leads to -- see cmds::check_update.
    let check_update = MenuItemBuilder::with_id("checkupdate", "Check for Updates…").build(app)?;

    // --- Open Recent -------------------------------------------------------
    let recent = win::prefs(app).recent();
    let mut submenu = SubmenuBuilder::new(app, "Open Recent");
    for (i, file) in recent.iter().enumerate() {
        // The name alone is ambiguous -- two projects have a README -- so each
        // row says which folder it came from, the way the sidebar does.
        let name = file.file_name().unwrap_or_default().to_string_lossy();
        let dir = file.parent().map(|d| home_relative(app, d)).unwrap_or_default();
        submenu = submenu.item(
            &MenuItemBuilder::with_id(format!("recent:{i}"), format!("{name}   {dir}")).build(app)?,
        );
    }
    if !recent.is_empty() {
        submenu = submenu.separator();
    }
    let recent_menu = submenu
        .item(
            &MenuItemBuilder::with_id("recent:clear", "Clear Menu")
                .enabled(!recent.is_empty())
                .build(app)?,
        )
        .build()?;

    // --- File --------------------------------------------------------------
    // Open and New Tab do the same thing: a file joins the window you are
    // looking at. New Window is the one that starts somewhere else.
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id("open", "Open…").accelerator("CmdOrCtrl+O").build(app)?)
        .item(&MenuItemBuilder::with_id("newtab", "New Tab…").accelerator("CmdOrCtrl+T").build(app)?)
        .item(
            &MenuItemBuilder::with_id("newwindow", "New Window…")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(&recent_menu)
        .separator()
        .item(
            &MenuItemBuilder::with_id("reveal", if mac { "Reveal in Finder" } else { "Show in Folder" })
                .accelerator("CmdOrCtrl+Shift+R")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("print", "Print…").accelerator("CmdOrCtrl+P").build(app)?)
        .separator()
        // Closing the only tab closes its window, so one shortcut covers both.
        .item(&MenuItemBuilder::with_id("closetab", "Close Tab").accelerator("CmdOrCtrl+W").build(app)?)
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&MenuItemBuilder::with_id("find", "Find…").accelerator("CmdOrCtrl+F").build(app)?)
        .build()?;

    // --- View --------------------------------------------------------------
    let mut view = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("side", "Sidebar").accelerator("CmdOrCtrl+B").build(app)?)
        // Two columns, two items. Neither is a checkbox: the page is the one
        // that knows whether either is up, and a menu that had to be told
        // would be wrong for the frame after every ⌘B.
        .item(
            &MenuItemBuilder::with_id("sidetoc", "Contents")
                .accelerator("Alt+CmdOrCtrl+B")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("view", "Rendered / Raw")
                .accelerator("CmdOrCtrl+Shift+V")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("diff", "Show Changes")
                .accelerator("CmdOrCtrl+Shift+D")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("markread", "Mark Read")
                .accelerator("CmdOrCtrl+Shift+M")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("next", "Next Change").accelerator("CmdOrCtrl+Down").build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("prev", "Previous Change")
                .accelerator("CmdOrCtrl+Up")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("zoomreset", "Actual Size").accelerator("CmdOrCtrl+0").build(app)?)
        .item(&MenuItemBuilder::with_id("zoomin", "Zoom In").accelerator("CmdOrCtrl+Plus").build(app)?)
        .item(&MenuItemBuilder::with_id("zoomout", "Zoom Out").accelerator("CmdOrCtrl+-").build(app)?)
        .separator()
        .item(
            &CheckMenuItemBuilder::with_id("ontop", "Always on Top")
                .accelerator("CmdOrCtrl+Alt+T")
                .checked(win::prefs(app).always_on_top())
                .build(app)?,
        )
        .fullscreen();

    if cfg!(debug_assertions) {
        view = view
            .separator()
            .item(&MenuItemBuilder::with_id("reload", "Reload").accelerator("CmdOrCtrl+R").build(app)?)
            .item(
                &MenuItemBuilder::with_id("devtools", "Developer Tools")
                    .accelerator("CmdOrCtrl+Alt+I")
                    .build(app)?,
            );
    }

    // --- Window ------------------------------------------------------------
    let mut window = SubmenuBuilder::new(app, "Window").minimize();
    if mac {
        window = window.maximize();
    }
    let window_menu = window
        .separator()
        // Our own tabs, so our own commands.
        .item(
            &MenuItemBuilder::with_id("nexttab", "Show Next Tab")
                .accelerator("Control+Tab")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("prevtab", "Show Previous Tab")
                .accelerator("Control+Shift+Tab")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("movetab", "Move Tab to New Window").build(app)?)
        .item(&MenuItemBuilder::with_id("mergeall", "Merge All Windows").build(app)?)
        .build()?;

    let mut bar = MenuBuilder::new(app);
    if mac {
        // Spelled out rather than taken whole, because the standard app menu
        // has no room for Settings -- and on a Mac that is where a Mac user
        // looks for it.
        bar = bar.item(
            &SubmenuBuilder::new(app, "Redline")
                .about(Some(AboutMetadata::default()))
                .item(&check_update)
                .separator()
                .item(&settings)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?,
        );
    }
    bar = bar.item(&file_menu).item(&edit_menu).item(&view.build()?).item(&window_menu);
    if !mac {
        // Nowhere else to put them: there is no app menu off a menu bar.
        bar = bar.item(
            &SubmenuBuilder::new(app, "Help")
                .item(&settings)
                .item(&check_update)
                .separator()
                .quit()
                .build()?,
        );
    }

    app.set_menu(bar.build()?)?;
    Ok(())
}

/// Rebuild, because Open Recent or the Always on Top tick has changed.
///
/// Hopped to the main thread rather than assumed to be on it: this is called
/// from wherever a file happened to arrive, and on macOS a menu may only be
/// built where the run loop is.
pub fn refresh(app: &AppHandle) {
    let app = app.clone();
    let _ = app.run_on_main_thread({
        let app = app.clone();
        move || {
            let _ = install(&app);
        }
    });
}

/// Kept under the old name because that is what the window code calls it for.
pub fn refresh_recent(app: &AppHandle) {
    refresh(app);
}

/// One command from the menu bar.
pub fn dispatch(app: &AppHandle, id: &str) {
    match id {
        // --- this side ---
        "open" | "newtab" => cmds::prompt(app.clone(), win::front(app), false),
        "newwindow" => cmds::prompt(app.clone(), None, true),
        "recent:clear" => {
            win::prefs(app).clear_recent();
            refresh(app);
        }
        "reveal" => {
            if let Some(abs) = win::front(app).and_then(|l| win::active_of(app, &l)) {
                cmds::reveal(app.clone(), abs.to_string_lossy().into_owned());
            }
        }
        "closetab" => {
            if let Some(label) = win::front(app) {
                win::close_tab(app, &label, None);
            }
        }
        "zoomin" => win::zoom(app, Some(0.1)),
        "zoomout" => win::zoom(app, Some(-0.1)),
        "zoomreset" => win::zoom(app, None),
        // The tick has already flipped; this is being told what it flipped to.
        "ontop" => win::set_always_on_top(app, !win::prefs(app).always_on_top()),
        "nexttab" => win::step_tab(app, 1),
        "prevtab" => win::step_tab(app, -1),
        "movetab" => win::move_tab_to_new_window(app),
        "mergeall" => win::merge_all_windows(app),
        "reload" => {
            if let Some(w) = win::front(app).and_then(|l| app.get_webview_window(&l)) {
                let _ = w.eval("location.reload()");
            }
        }
        "devtools" => {
            #[cfg(debug_assertions)]
            if let Some(w) = win::front(app).and_then(|l| app.get_webview_window(&l)) {
                w.open_devtools();
            }
        }

        // --- the page's side ---
        "settings" => win::to_front(app, "md:open-settings", ()),
        // Answered in Settings, where the version is, rather than in a modal
        // of its own: the page opens the sheet and asks.
        "checkupdate" => win::to_front(app, "md:check-update", ()),
        "side" => win::to_front(app, "md:toggle-side", ()),
        "sidetoc" => win::to_front(app, "md:toggle-toc", ()),
        "view" => win::to_front(app, "md:toggle-view", ()),
        "diff" => win::to_front(app, "md:toggle-diff", ()),
        "markread" => win::to_front(app, "md:mark-read", ()),
        "find" => win::to_front(app, "md:find", ()),
        // `window.print()` is a no-op in WKWebView, so this drives the native
        // print pipeline directly rather than going through the page. See
        // `print_window` for why that can't just be wry's own `print()`.
        "print" => {
            if let Some(w) = win::front(app).and_then(|l| app.get_webview_window(&l)) {
                print_window(&w);
            }
        }
        "next" => win::to_front(app, "md:next-change", ()),
        "prev" => win::to_front(app, "md:prev-change", ()),

        other => {
            if let Some(at) = other.strip_prefix("recent:").and_then(|n| n.parse::<usize>().ok()) {
                let Some(file) = win::prefs(app).recent().get(at).cloned() else { return };
                open_recent(app, file);
            }
        }
    }
}

/// Open something from Open Recent, or take it off the list.
fn open_recent(app: &AppHandle, file: PathBuf) {
    if win::open_file(app, &file, None) {
        return;
    }
    // Moved or deleted since. It is not coming back, so stop offering it.
    win::prefs(app).drop_recent(&file);
    refresh(app);
}
