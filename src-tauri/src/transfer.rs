//! Shared streaming engine. Network failures discard the affected session; downloads publish only after confirmation.
use crate::{clear_session, model::*, recover_after_error, validate_argument, Session};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    net::{Shutdown, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
pub(crate) const CANCELLED: &str =
    "Transfer cancelled. The connection was closed. Reconnect before continuing.";
static NEXT_TRANSFER_ID: AtomicU64 = AtomicU64::new(1);

pub(crate) struct ActiveTransfer {
    id: String,
    cancelled: AtomicBool,
    sockets: Mutex<Vec<TcpStream>>,
}

impl ActiveTransfer {
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }

    fn add_socket(&self, socket: &TcpStream) -> Result<(), String> {
        let socket = socket
            .try_clone()
            .map_err(|e| format!("Cannot monitor transfer socket: {e}"))?;
        let mut sockets = self.sockets.lock().map_err(|_| "Transfer unavailable.")?;
        // Synchronize registration with cancellation so a just-created socket cannot be missed.
        if self.cancelled.load(Ordering::Acquire) {
            let _ = socket.shutdown(Shutdown::Both);
        }
        sockets.push(socket);
        Ok(())
    }

    fn release_data_socket(&self) {
        // Retaining a clone would keep STOR's data connection open after finish(),
        // so the server could never observe EOF and send its completion reply.
        if let Ok(mut sockets) = self.sockets.lock() {
            sockets.truncate(1);
        }
    }

    fn stop_sockets(&self) {
        if let Ok(sockets) = self.sockets.lock() {
            for socket in sockets.iter() {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
    }
}

// Clearing the registration on every return path also prevents cancelling a later transfer.
struct TransferRegistration(Session);
impl Drop for TransferRegistration {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            *active = None;
        }
    }
}

pub(crate) fn cancel_session_transfer(session: &Session, id: &str) -> Result<bool, String> {
    let active = session.active.lock().map_err(|_| "Transfer unavailable.")?;
    if let Some(active) = active.as_ref().filter(|active| active.id == id) {
        active.cancelled.store(true, Ordering::Release);
        active.stop_sockets();
        return Ok(true);
    }
    Ok(false)
}

pub(crate) fn cancel_active(session: &Session) -> Result<(), String> {
    if let Some(active) = session
        .active
        .lock()
        .map_err(|_| "Transfer unavailable.")?
        .as_ref()
    {
        active.cancelled.store(true, Ordering::Release);
        active.stop_sockets();
    }
    Ok(())
}

// Copy bounded chunks and report measured I/O, never timer-generated progress.
fn copy_with_progress(
    reader: &mut impl Read,
    writer: &mut impl Write,
    active: &ActiveTransfer,
    total: Option<u64>,
    emit: &mut impl FnMut(TransferProgress),
) -> Result<u64, String> {
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0;
    let mut last = Instant::now();
    active.check()?;
    emit(TransferProgress {
        id: active.id.clone(),
        bytes,
        total,
    });
    loop {
        active.check()?;
        let read = match reader.read(&mut buffer) {
            Ok(read) => read,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("Cannot read transfer data: {e}")),
        };
        if read == 0 {
            break;
        }
        active.check()?;
        writer
            .write_all(&buffer[..read])
            .map_err(|e| format!("Cannot write transfer data: {e}"))?;
        bytes += read as u64;
        if last.elapsed() >= Duration::from_millis(100) {
            emit(TransferProgress {
                id: active.id.clone(),
                bytes,
                total,
            });
            last = Instant::now();
        }
    }
    active.check()?;
    Ok(bytes)
}

fn finish_registration(
    session: &Session,
    active: &ActiveTransfer,
    commit: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut registered = session.active.lock().map_err(|_| "Transfer unavailable.")?;
    active.check()?;
    commit()?;
    *registered = None;
    Ok(())
}

pub(crate) fn transfer_session(
    session: Session,
    input: TransferInput,
    mut emit: impl FnMut(TransferProgress),
) -> Result<(), String> {
    validate_argument(&input.source)?;
    validate_argument(&input.destination)?;
    let id = input.id.clone().unwrap_or_else(|| {
        format!(
            "native-{}",
            NEXT_TRANSFER_ID.fetch_add(1, Ordering::Relaxed)
        )
    });
    if id.trim().is_empty() || id.len() > 128 {
        return Err("Transfer IDs must contain 1 to 128 bytes.".into());
    }
    let mut slot = session.remote.lock().map_err(|_| "Session unavailable.")?;
    let ftp = slot.as_mut().ok_or("Connect to a server first.")?;
    let active = Arc::new(ActiveTransfer {
        id,
        cancelled: AtomicBool::new(false),
        sockets: Mutex::new(Vec::new()),
    });
    active.add_socket(&ftp.socket()?)?;
    *session.active.lock().map_err(|_| "Transfer unavailable.")? = Some(active.clone());
    let _registration = TransferRegistration(session.clone());
    let mut data_open = false;
    let result = (|| {
        let (bytes, total) = match input.direction {
            Direction::Upload => {
                if !input.destination.starts_with('/') {
                    return Err("Choose an absolute remote destination.".into());
                }
                let source_path = Path::new(&input.source);
                let metadata = fs::symlink_metadata(source_path)
                    .map_err(|e| format!("Cannot inspect source file: {e}"))?;
                if !metadata.is_file() {
                    return Err("Only regular files can be uploaded.".into());
                }
                let mut source =
                    File::open(source_path).map_err(|e| format!("Cannot open source file: {e}"))?;
                let total = Some(source.metadata().map_err(|e| e.to_string())?.len());
                let (_, name) = input
                    .destination
                    .rsplit_once('/')
                    .ok_or("Choose an absolute remote destination.")?;
                if name.is_empty() || name == "." || name == ".." || name.contains('\\') {
                    return Err("Choose a valid destination filename.".into());
                }
                active.check()?;
                let mut stream = ftp.open_upload(&input.destination)?;
                data_open = true;
                if let Some(socket) = stream.data_socket() {
                    if let Err(error) = active.add_socket(socket) {
                        active.stop_sockets();
                        return Err(error);
                    }
                }
                let copied =
                    copy_with_progress(&mut source, &mut stream, &active, total, &mut emit);
                // Prevent TransferStream::drop from waiting for control replies after a data failure.
                if copied.is_err() {
                    active.stop_sockets();
                }
                let bytes = copied?;
                active.release_data_socket();
                stream
                    .finish()
                    .map_err(|e| format!("The server did not confirm the upload: {e}"))?;
                data_open = false;
                finish_registration(&session, &active, || Ok(()))?;
                (bytes, total)
            }
            Direction::Download => {
                let destination = PathBuf::from(&input.destination);
                let parent = destination
                    .parent()
                    .ok_or("Choose a local destination folder.")?;
                if fs::symlink_metadata(&destination).is_ok() {
                    return Err(
                        "A local entry already exists with this name. Rename the file first."
                            .into(),
                    );
                }
                let mut temp = tempfile::NamedTempFile::new_in(parent)
                    .map_err(|e| format!("Cannot create download: {e}"))?;
                let total = ftp.size(&input.source)?;
                active.check()?;
                let mut stream = ftp.open_download(&input.source)?;
                data_open = true;
                if let Some(socket) = stream.data_socket() {
                    if let Err(error) = active.add_socket(socket) {
                        active.stop_sockets();
                        return Err(error);
                    }
                }
                let copied =
                    copy_with_progress(&mut stream, temp.as_file_mut(), &active, total, &mut emit);
                if copied.is_err() {
                    active.stop_sockets();
                }
                let bytes = copied?;
                active.release_data_socket();
                stream
                    .finish()
                    .map_err(|e| format!("The server did not confirm the download: {e}"))?;
                data_open = false;
                active.check()?;
                temp.flush()
                    .map_err(|e| format!("Cannot flush download: {e}"))?;
                temp.as_file()
                    .sync_all()
                    .map_err(|e| format!("Cannot save download: {e}"))?;
                finish_registration(&session, &active, || {
                    temp.persist_noclobber(destination)
                        .map(|_| ())
                        .map_err(|e| {
                            format!(
                                "Cannot save download without replacing an existing file: {}",
                                e.error
                            )
                        })
                })?;
                (bytes, total)
            }
        };
        emit(TransferProgress {
            id: active.id.clone(),
            bytes,
            total,
        });
        Ok(())
    })();
    if active.cancelled.load(Ordering::Acquire) {
        clear_session(&session, &mut slot);
        return Err(CANCELLED.into());
    }
    if let Err(error) = &result {
        if data_open {
            clear_session(&session, &mut slot);
            let detail = if matches!(input.direction, Direction::Upload) {
                " A partial remote file may remain."
            } else {
                ""
            };
            return Err(format!(
                "{} Connection closed; reconnect before continuing.{detail}",
                error
            ));
        }
        recover_after_error(&session, &mut slot);
    }
    result
}
