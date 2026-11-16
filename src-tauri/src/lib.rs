mod ftp;
mod model;
mod remote;
mod transfer;
#[cfg(test)]
use transfer::CANCELLED;
use transfer::{cancel_session_transfer, transfer_session};
mod ssh;
use chrono::{DateTime, Utc};
use model::*;
use remote::RemoteClient;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::SystemTime,
};
use tauri::{Emitter, Manager};

type Session = Arc<SessionState>;

struct SessionState {
    remote: Mutex<Option<RemoteClient>>,
    known_hosts: PathBuf,
    info: RwLock<Option<SessionInfo>>,
    active: Mutex<Option<Arc<transfer::ActiveTransfer>>>,
}

impl Default for SessionState {
    fn default() -> Self {
        Self::with_known_hosts(
            dirs::config_dir()
                .unwrap_or_else(std::env::temp_dir)
                .join("dev.betterftp.desktop/known_hosts"),
        )
    }
}
impl SessionState {
    fn with_known_hosts(known_hosts: PathBuf) -> Self {
        Self {
            remote: Mutex::new(None),
            info: RwLock::new(None),
            active: Mutex::new(None),
            known_hosts,
        }
    }
}

#[derive(Default)]
struct AppState {
    session: Session,
}

fn validate_argument(value: &str) -> Result<(), String> {
    if value.contains(['\r', '\n', '\0']) {
        return Err("Control characters are not allowed in FTP arguments.".into());
    }
    Ok(())
}

fn timestamp(value: SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339()
}

fn sorted(mut entries: Vec<FileEntry>) -> Vec<FileEntry> {
    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

fn remote_path(parent: &str, name: &str) -> String {
    format!("{}/{}", parent.trim_end_matches('/'), name)
}

fn session_info(session: &Session) -> Result<Option<SessionInfo>, String> {
    Ok(session
        .info
        .read()
        .map_err(|_| "Session unavailable.")?
        .clone())
}

fn clear_session(session: &Session, remote: &mut Option<RemoteClient>) {
    // Never send QUIT on an uncertain control channel. Closing it avoids stale replies.
    if let Some(ftp) = remote.take() {
        ftp.shutdown();
    }
    if let Ok(mut info) = session.info.write() {
        *info = None;
    }
}

fn recover_after_error(session: &Session, remote: &mut Option<RemoteClient>) {
    if remote.as_mut().is_some_and(|ftp| !ftp.healthy()) {
        clear_session(session, remote);
    }
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| "The native operation stopped unexpectedly.".to_string())?
}

#[tauri::command]
fn get_session(state: tauri::State<'_, AppState>) -> Result<Option<SessionInfo>, String> {
    session_info(&state.session)
}

#[tauri::command]
async fn inspect_ssh_host(
    state: tauri::State<'_, AppState>,
    input: ssh::HostInput,
) -> Result<ssh::HostInspection, String> {
    let path = state.session.known_hosts.clone();
    blocking(move || ssh::inspect(input, &path)).await
}

#[tauri::command]
async fn trust_ssh_host(
    state: tauri::State<'_, AppState>,
    input: ssh::TrustInput,
) -> Result<ssh::HostInspection, String> {
    let path = state.session.known_hosts.clone();
    blocking(move || ssh::trust(input, &path)).await
}

#[tauri::command]
async fn connect_remote(
    state: tauri::State<'_, AppState>,
    input: ConnectionInput,
) -> Result<ConnectionResult, String> {
    let session = state.session.clone();
    blocking(move || connect_session(session, input)).await
}

fn connect_session(session: Session, input: ConnectionInput) -> Result<ConnectionResult, String> {
    let protocol = input.protocol();
    validate_argument(&input.host)?;
    for value in [&input.username, &input.password] {
        if protocol == Protocol::Sftp {
            if value.contains('\0') {
                return Err("SSH credentials cannot contain NUL bytes.".into());
            }
        } else {
            validate_argument(value)?;
        }
    }
    if let Some(path) = &input.remote_path {
        validate_argument(path)?;
    }
    if input.host.trim().is_empty() || input.port == 0 {
        return Err("Enter a host and valid port.".into());
    }
    let mut slot = session.remote.lock().map_err(|_| "Session unavailable.")?;
    if slot.is_some() {
        return Err("Disconnect the current session before connecting again.".into());
    }
    if protocol != Protocol::Sftp && input.auth_method != AuthMethod::Password {
        return Err("FTP and FTPS support password authentication only.".into());
    }
    let mut remote = match protocol {
        Protocol::Sftp => RemoteClient::Sftp(ssh::connect(&input, &session.known_hosts)?),
        Protocol::Ftp | Protocol::Ftps => RemoteClient::Ftp(ftp::connect(&input)?),
    };
    let cwd = remote.initial_directory(input.remote_path.as_deref())?;
    *session.info.write().map_err(|_| "Session unavailable.")? = Some(SessionInfo {
        host: input.host,
        port: input.port,
        username: input.username,
        secure: protocol != Protocol::Ftp,
        protocol,
        auth_method: input.auth_method,
        cwd: cwd.clone(),
    });
    *slot = Some(remote);
    Ok(ConnectionResult { cwd })
}

#[tauri::command]
async fn disconnect_remote(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let session = state.session.clone();
    blocking(move || disconnect_session(session)).await
}

fn disconnect_session(session: Session) -> Result<(), String> {
    transfer::cancel_active(&session)?;
    let mut slot = session.remote.lock().map_err(|_| "Session unavailable.")?;
    clear_session(&session, &mut slot);
    Ok(())
}

#[tauri::command]
fn cancel_transfer(state: tauri::State<'_, AppState>, id: String) -> Result<bool, String> {
    cancel_session_transfer(&state.session, &id)
}

#[tauri::command]
async fn list_remote(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<LocalListing, String> {
    let session = state.session.clone();
    blocking(move || list_remote_listing(&session, &path)).await
}

#[cfg(test)]
fn list_remote_session(session: &Session, path: &str) -> Result<Vec<FileEntry>, String> {
    list_remote_listing(session, path).map(|listing| listing.entries)
}

fn list_remote_listing(session: &Session, path: &str) -> Result<LocalListing, String> {
    validate_argument(path)?;
    let mut slot = session.remote.lock().map_err(|_| "Session unavailable.")?;
    let result = (|| {
        let remote = slot.as_mut().ok_or("Connect to a server first.")?;
        let cwd = session_info(session)?.ok_or("Session unavailable.")?.cwd;
        let listing = remote.list(path, &cwd)?;
        if let Some(info) = session
            .info
            .write()
            .map_err(|_| "Session unavailable.")?
            .as_mut()
        {
            info.cwd = listing.path.clone();
        }
        Ok(listing)
    })();
    if result.is_err() {
        recover_after_error(session, &mut slot);
    }
    result
}

#[tauri::command]
async fn list_local(path: Option<String>) -> Result<LocalListing, String> {
    blocking(move || list_local_sync(path)).await
}

fn path_text(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "This path contains bytes that cannot be represented as Unicode.".into())
}

fn list_local_sync(path: Option<String>) -> Result<LocalListing, String> {
    let path = match path {
        Some(path) => PathBuf::from(path),
        None => dirs::home_dir().ok_or("Cannot locate your home folder.")?,
    };
    let path = fs::canonicalize(path).map_err(|e| format!("Cannot open local folder: {e}"))?;
    let mut entries = Vec::new();
    for item in fs::read_dir(&path).map_err(|e| format!("Cannot read local folder: {e}"))? {
        let item = item.map_err(|e| e.to_string())?;
        let metadata = fs::symlink_metadata(item.path()).map_err(|e| e.to_string())?;
        // Symlinks and device/FIFO/socket entries cannot be transferred safely as regular files.
        if !metadata.is_file() && !metadata.is_dir() {
            continue;
        }
        let item_path = path_text(&item.path())?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| "A filename in this folder cannot be represented as Unicode.")?;
        entries.push(FileEntry {
            name,
            path: item_path,
            is_directory: metadata.is_dir(),
            size: if metadata.is_dir() { 0 } else { metadata.len() },
            modified: metadata.modified().ok().map(timestamp),
        });
    }
    Ok(LocalListing {
        path: path_text(&path)?,
        entries: sorted(entries),
    })
}

#[tauri::command]
async fn transfer_file(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    input: TransferInput,
) -> Result<(), String> {
    let session = state.session.clone();
    blocking(move || {
        transfer_session(session, input, |progress| {
            let _ = app.emit("transfer-progress", progress);
        })
    })
    .await
}

#[cfg(target_os = "macos")]
fn guarded_macos_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    let menu = Menu::default(app)?;
    let name = app.config().product_name.as_deref().unwrap_or("Better FTP");
    let application_menu = Submenu::with_items(
        app,
        name,
        true,
        &[
            &PredefinedMenuItem::about(
                app,
                Some(&format!("About {name}")),
                Some(AboutMetadata {
                    name: Some(name.into()),
                    version: Some(app.package_info().version.to_string()),
                    ..Default::default()
                }),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&format!("Hide {name}")))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            // Cocoa's predefined Quit invokes terminate: directly, bypassing the window guard.
            &MenuItem::with_id(
                app,
                "guarded-quit",
                format!("Quit {name}"),
                true,
                Some("Cmd+Q"),
            )?,
        ],
    )?;
    // Tauri's macOS default starts with its application submenu. Keep all other menus.
    menu.remove_at(0)?;
    menu.insert(&application_menu, 0)?;
    Ok(menu)
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let known_hosts = app.path().app_config_dir()?.join("known_hosts");
            app.manage(AppState {
                session: Arc::new(SessionState::with_known_hosts(known_hosts)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_session,
            inspect_ssh_host,
            trust_ssh_host,
            connect_remote,
            disconnect_remote,
            cancel_transfer,
            list_remote,
            list_local,
            transfer_file
        ]);
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(guarded_macos_menu)
        .on_menu_event(|app, event| {
            if event.id() == "guarded-quit" {
                app.exit(0);
            }
        });
    builder
        .build(tauri::generate_context!())
        .expect("Unable to run Better FTP")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested {
                code: Some(_), api, ..
            } = event
            {
                if let Some(window) = app.get_webview_window("main") {
                    api.prevent_exit();
                    // close() emits CloseRequested, where the UI can confirm pending transfers.
                    // Destroying the final window requests exit with code None, so it is allowed
                    // through on the next event rather than recursively requesting close again.
                    if let Err(error) = window.close() {
                        eprintln!("Cannot request window close: {error}");
                    }
                }
            }
        });
}
#[cfg(test)]
mod tests;

#[cfg(test)]
mod ssh_tests;
