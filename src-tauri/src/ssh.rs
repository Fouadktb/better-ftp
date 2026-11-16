//! SFTP authentication and first-use trust. Verification always precedes credentials.
use crate::{model::*, path_text, remote_path, sorted, timestamp, validate_argument};
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    net::{IpAddr, TcpStream, ToSocketAddrs},
    path::Path,
    time::{Duration, SystemTime},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostInput {
    pub host: String,
    pub port: u16,
    pub timeout_seconds: Option<u32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrustInput {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    pub timeout_seconds: Option<u32>,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TrustStatus {
    Unknown,
    Trusted,
    Changed,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostInspection {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub status: TrustStatus,
}

pub(crate) struct SftpClient {
    pub sftp: ssh2::Sftp,
    pub socket: TcpStream,
    _session: ssh2::Session,
}
struct HostKey {
    key_type: String,
    key: Vec<u8>,
}
struct Handshake {
    session: ssh2::Session,
    socket: TcpStream,
    key: HostKey,
}

fn normalize_host(host: &str) -> Result<String, String> {
    validate_argument(host)?;
    let host = host.trim();
    let host = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ip.to_string());
    }
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty()
        || host.len() > 253
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    {
        return Err("Enter a DNS hostname or IP address without a URL, username, or port.".into());
    }
    Ok(host)
}
fn endpoint(host: &str, port: u16) -> Result<String, String> {
    if port == 0 {
        return Err("Enter a valid SSH port.".into());
    }
    Ok(format!("[{}]:{}", normalize_host(host)?, port))
}
fn fingerprint(key: &[u8]) -> String {
    format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(key)))
}

fn handshake(host: &str, port: u16, timeout: Duration) -> Result<Handshake, String> {
    let host = normalize_host(host)?;
    endpoint(&host, port)?;
    let addresses = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("Cannot resolve SSH host: {e}"))?;
    let deadline = std::time::Instant::now() + timeout;
    let mut socket = None;
    for address in addresses {
        let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) else {
            break;
        };
        if let Ok(stream) = TcpStream::connect_timeout(&address, remaining) {
            socket = Some(stream);
            break;
        }
    }
    let socket = socket.ok_or("Cannot reach the SSH server. Check the host, port, and network.")?;
    socket
        .set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    socket
        .set_write_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    let mut session = ssh2::Session::new().map_err(|e| format!("Cannot initialize SSH: {e}"))?;
    session.set_timeout(timeout.as_millis() as u32);
    session.set_tcp_stream(socket.try_clone().map_err(|e| e.to_string())?);
    session.method_pref(ssh2::MethodType::HostKey, "ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,rsa-sha2-512,rsa-sha2-256").map_err(|e| format!("Cannot configure SSH host-key algorithms: {e}"))?;
    session
        .handshake()
        .map_err(|e| format!("SSH handshake failed: {e}"))?;
    let (key, kind) = session
        .host_key()
        .ok_or("The SSH server supplied no host key.")?;
    let key_type = match kind {
        ssh2::HostKeyType::Rsa => "ssh-rsa",
        ssh2::HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
        ssh2::HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
        ssh2::HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
        ssh2::HostKeyType::Ed25519 => "ssh-ed25519",
        _ => return Err("The SSH server uses an unsupported host-key type.".into()),
    };
    let key = HostKey {
        key_type: key_type.into(),
        key: key.to_vec(),
    };
    Ok(Handshake {
        session,
        socket,
        key,
    })
}

// This application owns an OpenSSH-compatible known_hosts file. No global SSH files are modified.
fn read_hosts(path: &Path) -> Result<Vec<(String, HostKey)>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Cannot read SSH trust store: {e}")),
    };
    if text.len() > 1024 * 1024 {
        return Err("SSH trust store exceeds the supported size.".into());
    }
    let mut entries = Vec::new();
    for line in text
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
    {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 3 || !fields[0].starts_with('[') || !fields[0].contains("]:") {
            return Err("SSH trust store contains an unsupported or malformed entry. Review the application's known_hosts file.".into());
        }
        let key = STANDARD
            .decode(fields[2])
            .map_err(|_| "SSH trust store contains an invalid host key.")?;
        entries.push((
            fields[0].into(),
            HostKey {
                key_type: fields[1].into(),
                key,
            },
        ));
    }
    Ok(entries)
}
fn status(entries: &[(String, HostKey)], endpoint: &str, key: &HostKey) -> TrustStatus {
    let mut found = false;
    for (_, saved_key) in entries
        .iter()
        .filter(|(saved_host, _)| saved_host == endpoint)
    {
        found = true;
        if saved_key.key != key.key || saved_key.key_type != key.key_type {
            return TrustStatus::Changed;
        }
    }
    if found {
        TrustStatus::Trusted
    } else {
        TrustStatus::Unknown
    }
}
fn trust_lock(path: &Path) -> Result<std::fs::File, String> {
    let parent = path.parent().ok_or("Invalid SSH trust store location.")?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Cannot create SSH configuration folder: {e}"))?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("lock"))
        .map_err(|e| format!("Cannot open SSH trust lock: {e}"))?;
    fs2::FileExt::lock_exclusive(&file).map_err(|e| format!("Cannot lock SSH trust store: {e}"))?;
    Ok(file)
}
fn inspect_handshake(
    host: &str,
    port: u16,
    key: &HostKey,
    path: &Path,
) -> Result<HostInspection, String> {
    let _lock = trust_lock(path)?;
    let endpoint = endpoint(host, port)?;
    Ok(HostInspection {
        host: normalize_host(host)?,
        port,
        key_type: key.key_type.clone(),
        fingerprint: fingerprint(&key.key),
        status: status(&read_hosts(path)?, &endpoint, key),
    })
}

pub(crate) fn inspect(input: HostInput, path: &Path) -> Result<HostInspection, String> {
    let handshake = handshake(&input.host, input.port, timeout(input.timeout_seconds)?)?;
    inspect_handshake(&input.host, input.port, &handshake.key, path)
}
pub(crate) fn trust(input: TrustInput, path: &Path) -> Result<HostInspection, String> {
    let handshake = handshake(&input.host, input.port, timeout(input.timeout_seconds)?)?;
    if fingerprint(&handshake.key.key) != input.fingerprint {
        return Err("SSH host key no longer matches the fingerprint you reviewed. Inspect it again before trusting.".into());
    }
    let _lock = trust_lock(path)?;
    let endpoint = endpoint(&input.host, input.port)?;
    let mut entries = read_hosts(path)?;
    match status(&entries, &endpoint, &handshake.key) {
        TrustStatus::Changed => return Err("SSH host key changed. Replacing a saved key is blocked; verify the server and manage the application's known_hosts file manually.".into()),
        TrustStatus::Trusted => {},
        TrustStatus::Unknown => {
            entries.push((endpoint, HostKey { key_type: handshake.key.key_type.clone(), key: handshake.key.key.clone() }));
            let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid SSH trust store location.")?).map_err(|e| format!("Cannot save SSH trust: {e}"))?;
            for (host, key) in entries { writeln!(file, "{} {} {}", host, key.key_type, STANDARD.encode(key.key)).map_err(|e| e.to_string())?; }
            file.flush().map_err(|e| e.to_string())?;
            file.as_file().sync_all().map_err(|e| e.to_string())?;
            file.persist(path).map_err(|e| format!("Cannot save SSH trust: {}", e.error))?;
        }
    }
    Ok(HostInspection {
        host: normalize_host(&input.host)?,
        port: input.port,
        key_type: handshake.key.key_type,
        fingerprint: input.fingerprint,
        status: TrustStatus::Trusted,
    })
}

pub(crate) fn connect(input: &ConnectionInput, path: &Path) -> Result<SftpClient, String> {
    let handshake = handshake(&input.host, input.port, input.timeout()?)?;
    match inspect_handshake(&input.host, input.port, &handshake.key, path)?.status {
        TrustStatus::Trusted => {},
        TrustStatus::Unknown => return Err("SSH host key is unknown. Inspect and trust its SHA256 fingerprint before connecting.".into()),
        TrustStatus::Changed => return Err("SSH host key changed. Connection blocked. Verify the server and manage the application's known_hosts entry manually.".into()),
    }
    // Host identity was checked on this exact session before sending any authentication material.
    match input.auth_method {
        AuthMethod::Password => handshake.session.userauth_password(&input.username, &input.password).map_err(|_| "SSH password authentication failed. Check your username, password, and server authentication settings.".to_string())?,
        AuthMethod::PrivateKey => {
            let key = input.private_key_path.as_deref().filter(|key| !key.is_empty()).ok_or("Choose a private key file.")?;
            let key = fs::canonicalize(key).map_err(|e| format!("Cannot open private key: {e}"))?;
            if !key.is_file() { return Err("The private key path must be a regular file.".into()); }
            handshake.session.userauth_pubkey_file(&input.username, None, &key, (!input.password.is_empty()).then_some(input.password.as_str())).map_err(|e| format!("SSH private-key authentication failed. Check the key, passphrase, username, and server authorization: {e}"))?;
        }
        AuthMethod::Agent => {
            let mut agent = handshake.session.agent().map_err(|e| format!("Cannot access SSH agent: {e}"))?;
            agent.connect().map_err(|e| format!("Cannot connect to SSH agent: {e}"))?;
            agent.list_identities().map_err(|e| format!("Cannot list SSH agent identities: {e}"))?;
            let identities = agent.identities().map_err(|e| format!("Cannot read SSH agent identities: {e}"))?;
            if identities.is_empty() { return Err("The SSH agent contains no identities.".into()); }
            let mut authenticated = false;
            for identity in identities.iter().take(16) { if agent.userauth(&input.username, identity).is_ok() { authenticated = true; break; } }
            if !authenticated { return Err("SSH agent authentication failed. None of the first 16 identities was accepted.".into()); }
        }
    }
    if !handshake.session.authenticated() {
        return Err("SSH authentication was not completed.".into());
    }
    let sftp = handshake
        .session
        .sftp()
        .map_err(|e| format!("Cannot start the SFTP subsystem: {e}"))?;
    Ok(SftpClient {
        sftp,
        socket: handshake.socket,
        _session: handshake.session,
    })
}

impl SftpClient {
    pub fn canonical_directory(&self, path: &str, cwd: &str) -> Result<String, String> {
        validate_argument(path)?;
        let path = if path.starts_with('/') {
            path.to_owned()
        } else {
            remote_path(cwd, path)
        };
        let canonical = self
            .sftp
            .realpath(Path::new(&path))
            .map_err(|e| format!("Cannot resolve remote folder: {e}"))?;
        if !self
            .sftp
            .stat(&canonical)
            .map_err(|e| format!("Cannot inspect remote folder: {e}"))?
            .is_dir()
        {
            return Err("The remote path is not a folder.".into());
        }
        path_text(&canonical)
    }
    pub fn list(&self, path: &str, cwd: &str) -> Result<LocalListing, String> {
        let path = self.canonical_directory(path, cwd)?;
        let mut entries = Vec::new();
        for (entry, stat) in self
            .sftp
            .readdir(Path::new(&path))
            .map_err(|e| format!("Cannot list remote folder: {e}"))?
        {
            let name = entry
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("The remote server returned a non-Unicode filename.")?;
            if name == "." || name == ".." {
                continue;
            }
            validate_argument(name)?;
            if name.is_empty() || name.contains(['/', '\\']) {
                return Err("The remote server returned an invalid entry name.".into());
            }
            if stat.perm.is_some() && !stat.is_dir() && !stat.is_file() {
                continue;
            }
            entries.push(FileEntry {
                name: name.into(),
                path: remote_path(&path, name),
                is_directory: stat.is_dir(),
                size: if stat.is_dir() {
                    0
                } else {
                    stat.size.unwrap_or(0)
                },
                modified: stat
                    .mtime
                    .and_then(|seconds| {
                        SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs(seconds))
                    })
                    .map(timestamp),
            });
        }
        Ok(LocalListing {
            path,
            entries: sorted(entries),
        })
    }
}
