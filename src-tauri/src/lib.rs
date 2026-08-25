use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, State,
    Webview, WebviewUrl,
};
use url::Url;

/// Linux layout.
///
/// On Windows and macOS every webview is a real child surface and
/// `Webview::set_bounds` positions it. On Linux it is not: `tauri-runtime-wry`
/// builds every webview - the chrome one included - with `build_gtk` into the
/// window's single vertical `GtkBox`, packed with `expand: true, fill: true`.
/// Two visible webviews therefore always split the window in half horizontally,
/// and `wry`'s `set_bounds` is a no-op there (it only does something for X11
/// child windows or a `GtkFixed` parent), so no amount of bounds arithmetic can
/// move them.
///
/// So on Linux we let GTK do the layout instead. At startup the chrome webview
/// is lifted out of the default vbox and the two are put side by side:
///
/// ```text
/// GtkApplicationWindow            GtkApplicationWindow
///  └ vbox  (every webview)   ->    └ paned
///                                     ├ chrome webview (fixed width)
///                                     └ vbox (tab webviews, expands)
/// ```
///
/// Every later `add_child` still lands in the default vbox on its own, and only
/// one tab is ever visible, so GTK hands the visible one the whole content area
/// without us computing anything. Hiding the vbox collapses it entirely, which
/// is how the chrome takes over the full window for the onboarding screen.
#[cfg(target_os = "linux")]
mod linux_layout {
    use gtk::prelude::*;
    use tauri::{AppHandle, Manager};

    /// Picks the chrome webview out of the default vbox. A GTK menu bar would
    /// also live there, so match the webview by type rather than by position.
    fn chrome_widget(vbox: &gtk::Box) -> Option<gtk::Widget> {
        let children = vbox.children();
        children
            .iter()
            .find(|child| child.type_().name() == "WebKitWebView")
            .or_else(|| children.first())
            .cloned()
    }

    /// Resolves the widgets set up by `install`, or `None` if it never ran.
    fn parts(app: &AppHandle) -> Option<(gtk::Paned, gtk::Box, gtk::Widget)> {
        let window = app.get_window("main")?;
        let vbox = window.default_vbox().ok()?;
        let paned = vbox.parent()?.downcast::<gtk::Paned>().ok()?;
        let chrome = paned.child1()?;
        Some((paned, vbox, chrome))
    }

    /// The window shows through wherever no webview covers it, and the paned
    /// handle is a themed widget of its own, so both are painted to match the
    /// chrome instead of the light GTK defaults.
    fn apply_theme(window: &gtk::ApplicationWindow) {
        let provider = gtk::CssProvider::new();
        let css = b"window { background-color: #1e1f22; }
                    paned > separator { background-color: #35373b; background-image: none; min-width: 1px; }";
        if provider.load_from_data(css).is_err() {
            return;
        }
        if let Some(screen) = gtk::prelude::WidgetExt::screen(window) {
            gtk::StyleContext::add_provider_for_screen(
                &screen,
                &provider,
                gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
            );
        }
    }

    /// Runs once during setup, on the main thread, before any tab exists.
    pub fn install(app: &AppHandle) -> Result<(), String> {
        let window = app.get_window("main").ok_or("main window missing")?;
        let vbox = window.default_vbox().map_err(|e| e.to_string())?;
        let gtk_window = window.gtk_window().map_err(|e| e.to_string())?;
        let chrome = chrome_widget(&vbox).ok_or("chrome webview widget missing")?;

        vbox.remove(&chrome);
        gtk_window.remove(&vbox);

        // Not a GtkBox: a box hands a non-expanding child its *natural* width,
        // and WebKitGTK reports that as the whole window, which would leave the
        // tab area one pixel wide. GtkPaned allocates by an explicit position.
        let paned = gtk::Paned::new(gtk::Orientation::Horizontal);
        paned.pack1(&chrome, false, false);
        paned.pack2(&vbox, true, true);
        gtk_window.add(&paned);

        apply_theme(&gtk_window);

        paned.show();
        chrome.show();
        // Collapsed until the frontend reports it has a sidebar to show.
        vbox.hide();
        Ok(())
    }

    /// Switches between "chrome owns the window" (onboarding) and "chrome is a
    /// fixed sidebar next to the tab area". GTK is main-thread only and Tauri
    /// commands are not, so the work is marshalled and the widgets are looked
    /// up again inside the closure rather than captured.
    pub fn apply(app: &AppHandle, chrome_full: bool, sidebar_width: i32) {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            let Some((paned, vbox, chrome)) = parts(&app) else {
                return;
            };
            if chrome_full {
                chrome.set_size_request(-1, -1);
                vbox.hide();
            } else {
                let width = sidebar_width.max(1);
                chrome.set_size_request(width, -1);
                vbox.show();
                paned.set_position(width);
            }
        });
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Installation {
    id: String,
    name: String,
    address: String,
}

#[derive(Clone, Serialize)]
struct TabInfo {
    id: String,
    #[serde(rename = "installationId")]
    installation_id: String,
    #[serde(rename = "installationName")]
    installation_name: String,
    kind: String,
    #[serde(rename = "parentId")]
    parent_id: Option<String>,
    title: String,
}

struct TabEntry {
    webview: Webview,
    info: TabInfo,
}

#[derive(Default)]
struct AppState {
    installations: Mutex<Vec<Installation>>,
    tabs: Mutex<HashMap<String, TabEntry>>,
    active_tab: Mutex<Option<String>>,
}

#[derive(Deserialize)]
struct BoundsInput {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Serialize)]
struct NewChildTabRequest {
    #[serde(rename = "parentId")]
    parent_id: String,
    url: String,
}

#[derive(Clone, Serialize)]
struct TabTitleChanged {
    #[serde(rename = "tabId")]
    tab_id: String,
    title: String,
}

fn bounds_to_rect(bounds: &BoundsInput) -> Rect {
    Rect {
        position: Position::Logical(LogicalPosition::new(bounds.x, bounds.y)),
        size: Size::Logical(LogicalSize::new(
            bounds.width.max(1.0),
            bounds.height.max(1.0),
        )),
    }
}

fn origin_of(url: &Url) -> String {
    let scheme_host = format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default());
    match url.port() {
        Some(p) => format!("{}:{}", scheme_host, p),
        None => scheme_host,
    }
}

fn normalize_address(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Address is empty".into());
    }
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{}", trimmed)
    };
    let url = Url::parse(&with_scheme).map_err(|e| e.to_string())?;
    if url.host_str().is_none() {
        return Err("Address is missing a host".into());
    }
    let mut s = url.to_string();
    while s.ends_with('/') {
        s.pop();
    }
    Ok(s)
}

fn installations_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("installations.json"))
}

fn load_installations(app: &AppHandle) -> Vec<Installation> {
    let Ok(path) = installations_path(app) else {
        return Vec::new();
    };
    let Ok(data) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&data).unwrap_or_default()
}

fn save_installations(app: &AppHandle, list: &[Installation]) -> Result<(), String> {
    let path = installations_path(app)?;
    let data = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_installations(state: State<AppState>) -> Vec<Installation> {
    state.installations.lock().unwrap().clone()
}

async fn is_reachable(address: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client.get(address).send().await.is_ok()
}

#[tauri::command]
async fn add_installation(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    address: String,
) -> Result<Installation, String> {
    let normalized = normalize_address(&address)?;
    if !is_reachable(&normalized).await {
        return Err(format!(
            "Could not reach \"{}\". Check the address and make sure the server is running.",
            normalized
        ));
    }
    let display_name = if name.trim().is_empty() {
        normalized.clone()
    } else {
        name.trim().to_string()
    };
    let installation = Installation {
        id: uuid::Uuid::new_v4().to_string(),
        name: display_name,
        address: normalized,
    };
    let mut list = state.installations.lock().unwrap();
    list.push(installation.clone());
    save_installations(&app, &list)?;
    Ok(installation)
}

#[tauri::command]
fn remove_installation(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let stale_tab_ids: Vec<String> = {
        let tabs = state.tabs.lock().unwrap();
        tabs.values()
            .filter(|entry| entry.info.installation_id == id)
            .map(|entry| entry.info.id.clone())
            .collect()
    };
    for tab_id in stale_tab_ids {
        let _ = close_tab(state.clone(), tab_id);
    }

    let mut list = state.installations.lock().unwrap();
    list.retain(|i| i.id != id);
    save_installations(&app, &list)
}

#[tauri::command]
async fn check_reachable(address: String) -> bool {
    is_reachable(&address).await
}

#[tauri::command]
fn list_tabs(state: State<AppState>) -> Vec<TabInfo> {
    state
        .tabs
        .lock()
        .unwrap()
        .values()
        .map(|entry| entry.info.clone())
        .collect()
}

#[tauri::command]
fn open_tab(
    app: AppHandle,
    state: State<'_, AppState>,
    installation_id: String,
    kind: String,
    parent_id: Option<String>,
    bounds: BoundsInput,
    url: Option<String>,
) -> Result<TabInfo, String> {
    let installation = {
        let installations = state.installations.lock().unwrap();
        installations
            .iter()
            .find(|i| i.id == installation_id)
            .cloned()
            .ok_or_else(|| "Installation not found".to_string())?
    };

    let target_url = match url {
        Some(u) => u,
        None => {
            let path = if kind == "apphub" { "/pub/apphub/" } else { "" };
            format!("{}{}", installation.address, path)
        }
    };
    let parsed_url = Url::parse(&target_url).map_err(|e| e.to_string())?;
    let origin = origin_of(&parsed_url);

    let tab_id = uuid::Uuid::new_v4().to_string();
    let label = format!("tab-{}", tab_id.replace('-', ""));

    let window = app.get_window("main").ok_or("main window missing")?;

    let nav_origin = origin.clone();
    let nav_app = app.clone();

    let new_window_origin = origin.clone();
    let new_window_app = app.clone();
    let new_window_tab_id = tab_id.clone();

    let title_app = app.clone();
    let title_tab_id = tab_id.clone();

    let webview_builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(parsed_url))
        .on_navigation(move |nav_url| {
            if origin_of(nav_url) == nav_origin {
                true
            } else {
                let _ = tauri_plugin_opener::open_url(nav_url.to_string(), None::<&str>);
                let _ = nav_app.emit("mvmos://external-nav", nav_url.to_string());
                false
            }
        })
        .on_new_window(move |nav_url, _features| {
            if origin_of(&nav_url) == new_window_origin {
                let _ = new_window_app.emit(
                    "mvmos://new-child-tab",
                    NewChildTabRequest {
                        parent_id: new_window_tab_id.clone(),
                        url: nav_url.to_string(),
                    },
                );
            } else {
                let _ = tauri_plugin_opener::open_url(nav_url.to_string(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |_webview, title| {
            let state: State<AppState> = title_app.state();
            if let Some(entry) = state.tabs.lock().unwrap().get_mut(&title_tab_id) {
                entry.info.title = title.clone();
            }
            let _ = title_app.emit(
                "mvmos://tab-title",
                TabTitleChanged {
                    tab_id: title_tab_id.clone(),
                    title,
                },
            );
        });

    let rect = bounds_to_rect(&bounds);
    let webview = window
        .add_child(webview_builder, rect.position, rect.size)
        .map_err(|e| e.to_string())?;
    let _ = webview.hide();

    let title = match kind.as_str() {
        "apphub" => format!("{} — Public", installation.name),
        _ => installation.name.clone(),
    };

    let info = TabInfo {
        id: tab_id.clone(),
        installation_id: installation.id.clone(),
        installation_name: installation.name.clone(),
        kind,
        parent_id,
        title,
    };

    state.tabs.lock().unwrap().insert(
        tab_id,
        TabEntry {
            webview,
            info: info.clone(),
        },
    );

    Ok(info)
}

#[tauri::command]
fn activate_tab(state: State<AppState>, tab_id: String, bounds: BoundsInput) -> Result<(), String> {
    let mut active = state.active_tab.lock().unwrap();
    let tabs = state.tabs.lock().unwrap();

    if let Some(prev_id) = active.as_ref() {
        if prev_id != &tab_id {
            if let Some(prev) = tabs.get(prev_id) {
                let _ = prev.webview.hide();
            }
        }
    }

    let entry = tabs.get(&tab_id).ok_or("Tab not found")?;
    // On Linux the tab fills the content box GTK already sized for it, and
    // `set_bounds` would be a no-op anyway - see `linux_layout`.
    #[cfg(not(target_os = "linux"))]
    entry
        .webview
        .set_bounds(bounds_to_rect(&bounds))
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    let _ = &bounds;
    entry.webview.show().map_err(|e| e.to_string())?;
    *active = Some(tab_id);
    Ok(())
}

/// Keeps the chrome webview and the active tab from overlapping: the chrome is
/// either the sidebar strip or, while the onboarding screen is up, the whole
/// window. Linux gets there through the GTK hierarchy, every other platform
/// through webview bounds.
#[tauri::command]
fn sync_layout(
    app: AppHandle,
    state: State<AppState>,
    sidebar: BoundsInput,
    content: BoundsInput,
    chrome_full: bool,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = (&state, &content);
        linux_layout::apply(&app, chrome_full, sidebar.width.round() as i32);
        return Ok(());
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = chrome_full;
        let main_webview = app.get_webview("main").ok_or("main webview missing")?;
        main_webview
            .set_bounds(bounds_to_rect(&sidebar))
            .map_err(|e| e.to_string())?;

        let active = state.active_tab.lock().unwrap();
        if let Some(id) = active.as_ref() {
            let tabs = state.tabs.lock().unwrap();
            if let Some(entry) = tabs.get(id) {
                entry
                    .webview
                    .set_bounds(bounds_to_rect(&content))
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}

#[tauri::command]
fn close_tab(state: State<AppState>, tab_id: String) -> Result<(), String> {
    let mut tabs = state.tabs.lock().unwrap();

    let mut to_close = vec![tab_id];
    let mut i = 0;
    while i < to_close.len() {
        let current = to_close[i].clone();
        let children: Vec<String> = tabs
            .values()
            .filter(|entry| entry.info.parent_id.as_deref() == Some(current.as_str()))
            .map(|entry| entry.info.id.clone())
            .collect();
        for child in children {
            if !to_close.contains(&child) {
                to_close.push(child);
            }
        }
        i += 1;
    }

    for id in &to_close {
        if let Some(entry) = tabs.remove(id) {
            let _ = entry.webview.close();
        }
    }

    let mut active = state.active_tab.lock().unwrap();
    if let Some(active_id) = active.as_ref() {
        if to_close.contains(active_id) {
            *active = None;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let installations = load_installations(&handle);
            let state: State<AppState> = app.state();
            *state.installations.lock().unwrap() = installations;
            #[cfg(target_os = "linux")]
            linux_layout::install(&handle)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_installations,
            add_installation,
            remove_installation,
            check_reachable,
            list_tabs,
            open_tab,
            activate_tab,
            sync_layout,
            close_tab,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
