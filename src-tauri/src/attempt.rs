//! A connection attempt owns its sockets until the caller finishes or aborts it.
//! Socket shutdown does not need the session lock or a protocol handshake to finish.
use std::{
    net::{Shutdown, TcpStream, ToSocketAddrs},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

pub(crate) const CANCELLED: &str = "Connection aborted.";
#[derive(Default)]
struct Control {
    cancelled: bool,
    socket: Option<TcpStream>,
}
#[derive(Default)]
pub(crate) struct Attempt {
    control: Mutex<Control>,
}
impl Attempt {
    pub fn check(&self) -> Result<(), String> {
        self.commit(|| Ok(()))
    }
    pub fn commit<T>(&self, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let control = self
            .control
            .lock()
            .map_err(|_| "Connection attempt unavailable.")?;
        if control.cancelled {
            return Err(CANCELLED.into());
        }
        f()
    }
    pub fn cancelled(&self) -> bool {
        self.check().is_err()
    }
    pub fn cancel(&self) -> Result<(), String> {
        let mut control = self
            .control
            .lock()
            .map_err(|_| "Connection attempt unavailable.")?;
        control.cancelled = true;
        if let Some(socket) = control.socket.take() {
            let _ = socket.shutdown(Shutdown::Both);
        }
        Ok(())
    }
    pub fn track(&self, socket: &TcpStream) -> Result<(), String> {
        let mut control = self
            .control
            .lock()
            .map_err(|_| "Connection attempt unavailable.")?;
        if control.cancelled {
            let _ = socket.shutdown(Shutdown::Both);
            return Err(CANCELLED.into());
        }
        control.socket = Some(socket.try_clone().map_err(|e| e.to_string())?);
        Ok(())
    }
    pub fn result<T>(&self, result: Result<T, String>) -> Result<T, String> {
        self.check()?;
        result
    }
}

// Name resolution and connect_timeout are blocking OS calls. Keep them off the
// protocol worker so abort can return immediately. A late result only owns a TCP
// socket: a closed receiver drops it, and it can never authenticate or install a
// session. DNS itself remains subject to the OS resolver's timeout.
pub(crate) fn connect(
    host: &str,
    port: u16,
    timeout: Duration,
    attempt: &Arc<Attempt>,
) -> Result<TcpStream, String> {
    attempt.check()?;
    let host = host.to_owned();
    let token = attempt.clone();
    let (send, receive) = mpsc::sync_channel(1);
    let deadline = Instant::now() + timeout;
    std::thread::Builder::new()
        .name("connection-socket".into())
        .spawn(move || {
            let result = (|| {
                let addresses = (host.as_str(), port)
                    .to_socket_addrs()
                    .map_err(|e| format!("Cannot resolve host: {e}"))?;
                let mut last_error = None;
                for address in addresses {
                    token.check()?;
                    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                        break;
                    };
                    match TcpStream::connect_timeout(&address, remaining) {
                        Ok(socket) => return Ok(socket),
                        Err(error) => last_error = Some(error),
                    }
                }
                Err(format!(
                    "Cannot reach {host}:{port}: {}",
                    last_error
                        .map(|e| e.to_string())
                        .unwrap_or_else(|| "connection timed out or no addresses found".into())
                ))
            })();
            let _ = send.send(result);
        })
        .map_err(|e| format!("Cannot start connection: {e}"))?;
    loop {
        attempt.check()?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("Connection timed out.")?;
        match receive.recv_timeout(remaining.min(Duration::from_millis(25))) {
            Ok(result) => {
                let socket = attempt.result(result)?;
                attempt.track(&socket)?;
                socket
                    .set_read_timeout(Some(timeout))
                    .map_err(|e| e.to_string())?;
                socket
                    .set_write_timeout(Some(timeout))
                    .map_err(|e| e.to_string())?;
                return Ok(socket);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Connection worker stopped unexpectedly.".into())
            }
        }
    }
}
