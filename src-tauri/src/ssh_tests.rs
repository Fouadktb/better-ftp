//! Integration tests use a real SSH transport and chrooted SFTP server, never fake success responses.
use super::*;
use crate::ssh::{HostInput, TrustInput, TrustStatus};
use std::{
    fs::File,
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
};

struct Fixture {
    child: Child,
    port: u16,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn generate_key(path: &Path, passphrase: &str) {
    assert!(Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", passphrase, "-f"])
        .arg(path)
        .status()
        .unwrap()
        .success());
}
fn fixture(root: &Path, host_key: &Path, client_key: &Path, port: u16) -> Fixture {
    let python = std::env::var("BFTP_TEST_PYTHON")
        .expect("Set BFTP_TEST_PYTHON to Python with asyncssh installed");
    let mut child = Command::new(python)
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/sftp_fixture.py"
        ))
        .arg(root)
        .arg(host_key)
        .arg(client_key.with_extension("pub"))
        .arg(port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    Fixture {
        child,
        port: line.trim().parse().expect("SFTP fixture failed to start"),
    }
}
fn input(port: u16) -> ConnectionInput {
    ConnectionInput {
        host: "127.0.0.1".into(),
        port,
        username: "test".into(),
        password: "test".into(),
        protocol: Some(Protocol::Sftp),
        timeout_seconds: Some(5),
        ..Default::default()
    }
}
fn inspect(port: u16, path: &Path) -> ssh::HostInspection {
    ssh::inspect(
        HostInput {
            host: "127.0.0.1".into(),
            port,
            timeout_seconds: Some(5),
        },
        path,
    )
    .unwrap()
}
fn trust(port: u16, fingerprint: String, path: &Path) -> Result<ssh::HostInspection, String> {
    ssh::trust(
        TrustInput {
            host: "127.0.0.1".into(),
            port,
            fingerprint,
            timeout_seconds: Some(5),
        },
        path,
    )
}

#[test]
fn protocol_and_auth_inputs_are_backward_compatible() {
    let old: ConnectionInput = serde_json::from_value(serde_json::json!({"host":"example.com","port":21,"username":"alice","password":"secret","secure":true})).unwrap();
    assert_eq!(old.protocol(), Protocol::Ftps);
    assert_eq!(old.auth_method, AuthMethod::Password);
    let new: ConnectionInput = serde_json::from_value(serde_json::json!({"host":"example.com","port":22,"username":"alice","protocol":"sftp","authMethod":"privateKey","privateKeyPath":"/key","timeoutSeconds":12,"remotePath":"/data"})).unwrap();
    assert_eq!(new.protocol(), Protocol::Sftp);
    assert_eq!(new.auth_method, AuthMethod::PrivateKey);
    assert!(new.password.is_empty());
    assert_eq!(new.timeout().unwrap().as_secs(), 12);
    assert!(model::timeout(Some(0)).is_err());
    assert!(model::timeout(Some(301)).is_err());
}

#[test]
#[ignore = "Requires BFTP_TEST_PYTHON with asyncssh and ssh-keygen; opens loopback ports"]
fn sftp_host_trust_password_roundtrip_and_cancel() {
    let root = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let host_key = local.path().join("host");
    let client_key = local.path().join("client");
    generate_key(&host_key, "");
    generate_key(&client_key, "");
    let fixture = fixture(root.path(), &host_key, &client_key, 0);
    let port = fixture.port;
    let path = config.path().join("known_hosts");
    let session = Arc::new(SessionState::with_known_hosts(path.clone()));
    assert!(connect_session(session.clone(), input(port))
        .err()
        .unwrap()
        .contains("unknown"));
    assert!(
        !root.path().join("auth-attempts").exists(),
        "No credentials may be sent before host-key trust"
    );
    let host = inspect(port, &path);
    assert_eq!(host.status, TrustStatus::Unknown);
    assert_eq!(host.key_type, "ssh-ed25519");
    assert!(host.fingerprint.starts_with("SHA256:"));
    assert!(trust(port, "SHA256:wrong".into(), &path).is_err());
    assert!(!path.exists());
    trust(port, host.fingerprint.clone(), &path).unwrap();
    assert_eq!(inspect(port, &path).status, TrustStatus::Trusted);
    assert!(fs::read_to_string(&path).unwrap().contains("ssh-ed25519"));
    let openssh = Command::new("ssh-keygen")
        .args(["-l", "-E", "sha256", "-f"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(openssh.status.success());
    assert!(String::from_utf8(openssh.stdout)
        .unwrap()
        .contains(&host.fingerprint));
    let bad = connect_session(
        session.clone(),
        ConnectionInput {
            password: "wrong".into(),
            ..input(port)
        },
    );
    assert!(bad.err().unwrap().contains("authentication failed"));
    assert!(session_info(&session).unwrap().is_none());
    let bad_dir = connect_session(
        session.clone(),
        ConnectionInput {
            remote_path: Some("/missing".into()),
            ..input(port)
        },
    );
    assert!(bad_dir.is_err());
    assert!(session_info(&session).unwrap().is_none());
    assert!(session.remote.lock().unwrap().is_none());
    fs::create_dir(root.path().join("files")).unwrap();
    assert_eq!(
        connect_session(
            session.clone(),
            ConnectionInput {
                remote_path: Some("/files".into()),
                ..input(port)
            }
        )
        .unwrap()
        .cwd,
        "/files"
    );
    let info = session_info(&session).unwrap().unwrap();
    assert_eq!(info.protocol, Protocol::Sftp);
    assert_eq!(info.auth_method, AuthMethod::Password);
    assert_eq!(
        list_remote_listing(&session, "../files/.").unwrap().path,
        "/files"
    );
    let payload: Vec<_> = (0..600_000).map(|i| (i % 251) as u8).collect();
    let source = local.path().join("source.bin");
    fs::write(&source, &payload).unwrap();
    let upload = || TransferInput {
        id: Some("sftp-upload".into()),
        direction: Direction::Upload,
        source: source.to_str().unwrap().into(),
        destination: "/files/résumé.bin".into(),
    };
    let mut progress = Vec::new();
    transfer_session(session.clone(), upload(), |event| progress.push(event)).unwrap();
    assert_eq!(progress.first().unwrap().bytes, 0);
    assert_eq!(progress.last().unwrap().bytes, payload.len() as u64);
    assert!(progress
        .iter()
        .all(|event| event.total == Some(payload.len() as u64)));
    assert_eq!(
        fs::read(root.path().join("files/résumé.bin")).unwrap(),
        payload
    );
    assert!(
        transfer_session(session.clone(), upload(), |_| {}).is_err(),
        "Exclusive SFTP create must refuse replacing an existing file"
    );
    assert_eq!(
        fs::read(root.path().join("files/résumé.bin")).unwrap(),
        payload
    );
    let destination = local.path().join("downloaded");
    let download = || TransferInput {
        id: Some("sftp-download".into()),
        direction: Direction::Download,
        source: "/files/résumé.bin".into(),
        destination: destination.to_str().unwrap().into(),
    };
    transfer_session(session.clone(), download(), |_| {}).unwrap();
    assert_eq!(fs::read(&destination).unwrap(), payload);
    assert!(transfer_session(session.clone(), download(), |_| {}).is_err());
    let listing = list_remote_listing(&session, "/files").unwrap();
    assert_eq!(listing.entries[0].name, "résumé.bin");
    assert_eq!(listing.entries[0].size, payload.len() as u64);
    let cancelled = local.path().join("cancelled");
    let error = transfer_session(
        session.clone(),
        TransferInput {
            destination: cancelled.to_str().unwrap().into(),
            ..download()
        },
        |event| {
            assert!(cancel_session_transfer(&session, &event.id).unwrap());
        },
    )
    .unwrap_err();
    assert_eq!(error, CANCELLED);
    assert!(!cancelled.exists());
    assert!(session_info(&session).unwrap().is_none());
    connect_session(session.clone(), input(port)).unwrap();
    assert!(list_remote_listing(&session, "/files").is_ok());
    disconnect_session(session).unwrap();
}

#[test]
#[ignore = "Requires BFTP_TEST_PYTHON with asyncssh and ssh-keygen; opens loopback ports"]
fn sftp_private_key_auth_and_changed_key_blocking() {
    let root = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let host_key = local.path().join("host");
    let changed_key = local.path().join("changed");
    let client_key = local.path().join("client");
    generate_key(&host_key, "");
    generate_key(&changed_key, "");
    generate_key(&client_key, "key-passphrase");
    let mut server = fixture(root.path(), &host_key, &client_key, 0);
    let port = server.port;
    let path = config.path().join("known_hosts");
    let first = inspect(port, &path);
    trust(port, first.fingerprint.clone(), &path).unwrap();
    let session = Arc::new(SessionState::with_known_hosts(path.clone()));
    let private = || ConnectionInput {
        auth_method: AuthMethod::PrivateKey,
        private_key_path: Some(client_key.to_str().unwrap().into()),
        password: "key-passphrase".into(),
        ..input(port)
    };
    assert!(connect_session(
        session.clone(),
        ConnectionInput {
            password: "wrong-passphrase".into(),
            ..private()
        }
    )
    .is_err());
    connect_session(session.clone(), private()).unwrap();
    assert_eq!(
        session_info(&session).unwrap().unwrap().auth_method,
        AuthMethod::PrivateKey
    );
    disconnect_session(session.clone()).unwrap();
    let _ = server.child.kill();
    let _ = server.child.wait();
    let _changed = fixture(root.path(), &changed_key, &client_key, port);
    let changed = inspect(port, &path);
    assert_eq!(changed.status, TrustStatus::Changed);
    assert_ne!(changed.fingerprint, first.fingerprint);
    assert!(trust(port, changed.fingerprint, &path)
        .unwrap_err()
        .contains("changed"));
    assert!(connect_session(session.clone(), private())
        .err()
        .unwrap()
        .contains("changed"));
    assert!(session_info(&session).unwrap().is_none());
    assert_eq!(fs::read_to_string(path).unwrap().lines().count(), 1);
}

#[test]
#[ignore = "Requires BFTP_TEST_PYTHON with asyncssh and ssh-keygen; opens loopback ports"]
fn sftp_dropped_server_discards_partial_download() {
    let root = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let host_key = local.path().join("host");
    let client_key = local.path().join("client");
    generate_key(&host_key, "");
    generate_key(&client_key, "");
    File::create(root.path().join("large"))
        .unwrap()
        .set_len(64 * 1024 * 1024)
        .unwrap();
    let mut server = fixture(root.path(), &host_key, &client_key, 0);
    let port = server.port;
    let path = config.path().join("known_hosts");
    trust(port, inspect(port, &path).fingerprint, &path).unwrap();
    let session = Arc::new(SessionState::with_known_hosts(path));
    connect_session(session.clone(), input(port)).unwrap();
    let destination = local.path().join("failed");
    let error = transfer_session(
        session.clone(),
        TransferInput {
            id: Some("drop".into()),
            direction: Direction::Download,
            source: "/large".into(),
            destination: destination.to_str().unwrap().into(),
        },
        |_| {
            let _ = server.child.kill();
            let _ = server.child.wait();
        },
    )
    .unwrap_err();
    assert!(error.contains("Connection closed"), "{error}");
    assert!(!destination.exists());
    assert!(session_info(&session).unwrap().is_none());
}

#[cfg(unix)]
#[test]
#[ignore = "Requires BFTP_TEST_PYTHON with asyncssh, ssh-keygen, ssh-agent, and ssh-add"]
fn sftp_agent_authentication() {
    // An isolated child test process gets SSH_AUTH_SOCK, avoiding global environment mutation
    // while the rest of the test suite runs concurrently.
    if let Ok(port) = std::env::var("BFTP_TEST_AGENT_PORT") {
        let path = PathBuf::from(std::env::var("BFTP_TEST_AGENT_HOSTS").unwrap());
        let session = Arc::new(SessionState::with_known_hosts(path));
        connect_session(
            session.clone(),
            ConnectionInput {
                auth_method: AuthMethod::Agent,
                password: String::new(),
                ..input(port.parse().unwrap())
            },
        )
        .unwrap();
        assert_eq!(
            session_info(&session).unwrap().unwrap().auth_method,
            AuthMethod::Agent
        );
        disconnect_session(session).unwrap();
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let host_key = local.path().join("host");
    let client_key = local.path().join("client");
    generate_key(&host_key, "");
    generate_key(&client_key, "");
    let server = fixture(root.path(), &host_key, &client_key, 0);
    let port = server.port;
    let path = config.path().join("known_hosts");
    trust(port, inspect(port, &path).fingerprint, &path).unwrap();
    let socket = local.path().join("agent.sock");
    let agent = Command::new("ssh-agent")
        .arg("-D")
        .arg("-a")
        .arg(&socket)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut agent = Fixture {
        child: agent,
        port: 0,
    };
    let mut ready = String::new();
    BufReader::new(agent.child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert!(socket.exists(), "ssh-agent did not create its socket");
    assert!(Command::new("ssh-add")
        .arg(&client_key)
        .env("SSH_AUTH_SOCK", &socket)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success());
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "ssh_tests::sftp_agent_authentication",
            "--nocapture",
        ])
        .env("SSH_AUTH_SOCK", &socket)
        .env("BFTP_TEST_AGENT_PORT", port.to_string())
        .env("BFTP_TEST_AGENT_HOSTS", &path)
        .status()
        .unwrap();
    assert!(
        status.success(),
        "SSH agent authentication failed in isolated test process"
    );
}
