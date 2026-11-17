mod attempt;
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
    sync::atomic::{AtomicU64, Ordering},
    sync::{Arc, Mutex, RwLock},
    time::SystemTime,
};
use tauri::{Emitter, Manager};

type Session = Arc<SessionState>;

struct SessionState {
    remote: Mutex<Option<RemoteClient>>,
    attempt: Mutex<Option<(String, Arc<attempt::Attempt>)>>,
    connected_attempt: Mutex<Option<String>>,
    next_attempt: AtomicU64,
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
            attempt: Mutex::new(None),
            connected_attempt: Mutex::new(None),
            next_attempt: AtomicU64::new(1),
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
    if let Ok(mut installed) = session.connected_attempt.lock() {
        *installed = None;
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

fn begin_attempt(session: &Session) -> Result<String, String> {
    let mut current = session
        .attempt
        .lock()
        .map_err(|_| "Connection attempt unavailable.")?;
    if current
        .as_ref()
        .is_some_and(|(_, token)| !token.cancelled())
    {
        return Err("A connection attempt is already running.".into());
    }
    let id = session
        .next_attempt
        .fetch_add(1, Ordering::Relaxed)
        .to_string();
    *current = Some((id.clone(), Arc::new(attempt::Attempt::default())));
    Ok(id)
}
fn attempt_token(session: &Session, id: Option<&str>) -> Result<Arc<attempt::Attempt>, String> {
    let Some(id) = id else {
        return Ok(Arc::new(attempt::Attempt::default()));
    };
    let current = session
        .attempt
        .lock()
        .map_err(|_| "Connection attempt unavailable.")?;
    let token = current
        .as_ref()
        .filter(|(current_id, _)| current_id == id)
        .map(|(_, token)| token.clone())
        .ok_or(attempt::CANCELLED)?;
    token.check()?;
    Ok(token)
}
fn cancel_attempt(session: &Session, id: &str) -> Result<(), String> {
    let current = session
        .attempt
        .lock()
        .map_err(|_| "Connection attempt unavailable.")?;
    if let Some((_, token)) = current.as_ref().filter(|(current_id, _)| current_id == id) {
        token.cancel()?;
    }
    drop(current);
    let mut slot = session.remote.lock().map_err(|_| "Session unavailable.")?;
    let installed = session
        .connected_attempt
        .lock()
        .map_err(|_| "Session unavailable.")?
        .clone();
    if installed.as_deref() == Some(id) {
        clear_session(session, &mut slot);
    }
    Ok(())
}
#[tauri::command]
fn begin_connection_attempt(state: tauri::State<'_, AppState>) -> Result<String, String> {
    begin_attempt(&state.session)
}
#[tauri::command]
async fn cancel_connection_attempt(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let session = state.session.clone();
    blocking(move || cancel_attempt(&session, &id)).await
}
#[tauri::command]
fn end_connection_attempt(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let mut current = state
        .session
        .attempt
        .lock()
        .map_err(|_| "Connection attempt unavailable.")?;
    if current
        .as_ref()
        .is_some_and(|(current_id, _)| current_id == &id)
    {
        *current = None;
    }
    Ok(())
}
#[tauri::command]
async fn inspect_ssh_host(
    state: tauri::State<'_, AppState>,
    input: ssh::HostInput,
    attempt_id: Option<String>,
) -> Result<ssh::HostInspection, String> {
    let path = state.session.known_hosts.clone();
    let token = attempt_token(&state.session, attempt_id.as_deref())?;
    blocking(move || token.result(ssh::inspect_with_attempt(input, &path, &token))).await
}
#[tauri::command]
async fn trust_ssh_host(
    state: tauri::State<'_, AppState>,
    input: ssh::TrustInput,
    attempt_id: Option<String>,
) -> Result<ssh::HostInspection, String> {
    let path = state.session.known_hosts.clone();
    let token = attempt_token(&state.session, attempt_id.as_deref())?;
    blocking(move || token.result(ssh::trust_with_attempt(input, &path, &token))).await
}
#[tauri::command]
async fn connect_remote(
    state: tauri::State<'_, AppState>,
    input: ConnectionInput,
    attempt_id: Option<String>,
) -> Result<ConnectionResult, String> {
    let session = state.session.clone();
    let token = attempt_token(&session, attempt_id.as_deref())?;
    blocking(move || token.result(connect_session_attempt(session, input, &token, attempt_id)))
        .await
}
#[cfg(test)]
fn connect_session(session: Session, input: ConnectionInput) -> Result<ConnectionResult, String> {
    connect_session_attempt(session, input, &Arc::new(attempt::Attempt::default()), None)
}
fn connect_session_attempt(
    session: Session,
    input: ConnectionInput,
    token: &Arc<attempt::Attempt>,
    attempt_id: Option<String>,
) -> Result<ConnectionResult, String> {
    token.check()?;
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
    if session
        .remote
        .lock()
        .map_err(|_| "Session unavailable.")?
        .is_some()
    {
        return Err("Disconnect the current session before connecting again.".into());
    }
    if protocol != Protocol::Sftp && input.auth_method != AuthMethod::Password {
        return Err("FTP and FTPS support password authentication only.".into());
    }
    let mut remote = match protocol {
        Protocol::Sftp => RemoteClient::Sftp(ssh::connect(&input, &session.known_hosts, token)?),
        Protocol::Ftp | Protocol::Ftps => RemoteClient::Ftp(ftp::connect(&input, token)?),
    };
    let cwd = remote.initial_directory(input.remote_path.as_deref())?;
    let mut slot = session.remote.lock().map_err(|_| "Session unavailable.")?;
    token.commit(|| {
        if slot.is_some() {
            return Err("Disconnect the current session before connecting again.".into());
        }
        *session.info.write().map_err(|_| "Session unavailable.")? = Some(SessionInfo {
            host: input.host,
            port: input.port,
            username: input.username,
            secure: protocol != Protocol::Ftp,
            protocol,
            auth_method: input.auth_method,
            cwd: cwd.clone(),
        });
        *session
            .connected_attempt
            .lock()
            .map_err(|_| "Session unavailable.")? = attempt_id;
        *slot = Some(remote);
        Ok(ConnectionResult { cwd })
    })
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
            begin_connection_attempt,
            cancel_connection_attempt,
            end_connection_attempt,
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
