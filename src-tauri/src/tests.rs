use super::*;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

#[test]
fn rejects_ftp_command_injection() {
    for value in ["a\r\nDELE victim", "a\nQUIT", "a\0b"] {
        assert!(validate_argument(value).is_err());
    }
    assert!(validate_argument("résumé with spaces.txt").is_ok());
}

#[test]
fn lists_local_folders_before_files() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("Alpha.txt"), b"abc").unwrap();
    fs::create_dir(root.path().join("zeta")).unwrap();
    let listing = list_local_sync(Some(root.path().to_string_lossy().into())).unwrap();
    assert_eq!(listing.entries.len(), 2);
    assert_eq!(listing.entries[0].name, "zeta");
    assert!(listing.entries[0].is_directory);
    assert_eq!(listing.entries[1].size, 3);
}

struct Fixture(Child);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn fixture(root: &std::path::Path, cert: Option<&std::path::Path>) -> (Fixture, u16) {
    let python = std::env::var("BFTP_TEST_PYTHON")
        .expect("Set BFTP_TEST_PYTHON to a Python with pyftpdlib and pyopenssl installed");
    let mut command = Command::new(python);
    command
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/ftp_fixture.py"))
        .arg(root);
    if let Some(cert) = cert {
        command.arg(cert);
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let port = line.trim().parse().expect("Fixture failed to start");
    (Fixture(child), port)
}

fn connection(port: u16, secure: bool) -> ConnectionInput {
    ConnectionInput {
        host: "127.0.0.1".into(),
        port,
        username: "test".into(),
        password: "test".into(),
        secure,
        ..Default::default()
    }
}

#[test]
#[ignore = "Requires BFTP_TEST_PYTHON with pyftpdlib; opens loopback ports"]
fn real_ftp_roundtrip_and_collision_guards() {
    let remote = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let (_fixture, port) = fixture(remote.path(), None);
    let session: Session = Default::default();
    assert_eq!(
        connect_session(session.clone(), connection(port, false))
            .unwrap()
            .cwd,
        "/"
    );
    let payload: Vec<u8> = (0..262144).map(|i| (i % 251) as u8).collect();
    let source = local.path().join("source.bin");
    let destination = local.path().join("download.bin");
    fs::write(&source, &payload).unwrap();
    let upload = || TransferInput {
        id: None,
        direction: Direction::Upload,
        source: source.to_string_lossy().into(),
        destination: "/résumé.bin".into(),
    };
    transfer_session(session.clone(), upload(), |_| {}).unwrap();
    assert!(transfer_session(session.clone(), upload(), |_| {})
        .unwrap_err()
        .contains("already exists"));
    let entries = list_remote_session(&session, "/").unwrap();
    assert_eq!(entries[0].name, "résumé.bin");
    assert_eq!(entries[0].size, payload.len() as u64);
    let download = || TransferInput {
        id: None,
        direction: Direction::Download,
        source: "/résumé.bin".into(),
        destination: destination.to_string_lossy().into(),
    };
    transfer_session(session.clone(), download(), |_| {}).unwrap();
    assert_eq!(fs::read(&destination).unwrap(), payload);
    assert!(transfer_session(session.clone(), download(), |_| {})
        .unwrap_err()
        .contains("already exists"));
    assert_eq!(fs::read(&destination).unwrap(), payload);
    let invalid = connect_session(
        Default::default(),
        ConnectionInput {
            password: "wrong".into(),
            ..connection(port, false)
        },
    );
    assert!(invalid.is_err());
}

#[test]
fn session_and_transfer_contracts_exclude_credentials() {
    let info = SessionInfo {
        host: "localhost".into(),
        port: 21,
        username: "alice".into(),
        secure: true,
        protocol: Protocol::Ftps,
        auth_method: AuthMethod::Password,
        cwd: "/files".into(),
    };
    let json = serde_json::to_value(info).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 7);
    assert!(json.get("password").is_none());
    assert_eq!(json["secure"], true);
    let input: TransferInput =
        serde_json::from_str(r#"{"direction":"download","source":"/a","destination":"/b"}"#)
            .unwrap();
    assert!(input.id.is_none());
    let progress = TransferProgress {
        id: "queue-1".into(),
        bytes: 64,
        total: None,
    };
    assert_eq!(
        serde_json::to_value(progress).unwrap(),
        serde_json::json!({"id":"queue-1","bytes":64,"total":null})
    );
    let session = Session::default();
    assert!(session_info(&session).unwrap().is_none());
    assert!(!cancel_session_transfer(&session, "missing").unwrap());
}

#[test]
#[ignore = "Requires BFTP_TEST_PYTHON with pyftpdlib; opens loopback ports"]
fn recovers_metadata_and_reports_measured_progress() {
    let remote = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    fs::create_dir(remote.path().join("files")).unwrap();
    let (_fixture, port) = fixture(remote.path(), None);
    let session = Session::default();
    connect_session(session.clone(), connection(port, false)).unwrap();
    let info = session_info(&session).unwrap().unwrap();
    assert_eq!(info.host, "127.0.0.1");
    assert_eq!(info.port, port);
    assert_eq!(info.username, "test");
    assert!(!info.secure);
    let listing = list_remote_listing(&session, "files/../files").unwrap();
    assert_eq!(listing.path, "/files");
    assert!(listing.entries.is_empty());
    let listing_json = serde_json::to_value(&listing).unwrap();
    assert_eq!(listing_json["path"], "/files");
    assert!(listing_json["entries"].is_array());
    assert_eq!(session_info(&session).unwrap().unwrap().cwd, listing.path);
    // An ordinary permission/path error must leave the control channel usable.
    assert!(list_remote_session(&session, "/missing").is_err());
    assert_eq!(session_info(&session).unwrap().unwrap().cwd, "/files");
    assert!(list_remote_session(&session, "/files").is_ok());
    let source = local.path().join("source");
    let payload = vec![0x81; 300_000];
    fs::write(&source, &payload).unwrap();
    let mut progress = Vec::new();
    transfer_session(
        session.clone(),
        TransferInput {
            id: Some("upload-id".into()),
            direction: Direction::Upload,
            source: source.to_str().unwrap().into(),
            destination: "/files/uploaded".into(),
        },
        |event| {
            progress.push(event);
        },
    )
    .unwrap();
    assert!(!cancel_session_transfer(&session, "upload-id").unwrap());
    assert_eq!(progress.first().unwrap().bytes, 0);
    assert_eq!(progress.last().unwrap().bytes, payload.len() as u64);
    assert!(progress
        .iter()
        .all(|event| event.id == "upload-id" && event.total == Some(payload.len() as u64)));
    assert!(progress
        .windows(2)
        .all(|events| events[0].bytes <= events[1].bytes));
    assert_eq!(
        fs::read(remote.path().join("files/uploaded")).unwrap(),
        payload
    );
    let destination = local.path().join("downloaded");
    progress.clear();
    transfer_session(
        session.clone(),
        TransferInput {
            id: Some("download-id".into()),
            direction: Direction::Download,
            source: "/files/uploaded".into(),
            destination: destination.to_str().unwrap().into(),
        },
        |event| progress.push(event),
    )
    .unwrap();
    assert_eq!(progress.first().unwrap().bytes, 0);
    assert_eq!(progress.last().unwrap().bytes, payload.len() as u64);
    assert!(progress
        .iter()
        .all(|event| event.total == Some(payload.len() as u64)));
    assert_eq!(fs::read(destination).unwrap(), payload);
    disconnect_session(session.clone()).unwrap();
    assert!(session_info(&session).unwrap().is_none());
    assert!(session.remote.lock().unwrap().is_none());
}

#[test]
#[ignore = "Requires BFTP_TEST_PYTHON with pyftpdlib; opens loopback ports"]
fn cancellation_cleans_download_and_invalidates_session() {
    let remote = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    fs::write(remote.path().join("source"), vec![7; 300_000]).unwrap();
    let (_fixture, port) = fixture(remote.path(), None);
    let session = Session::default();
    connect_session(session.clone(), connection(port, false)).unwrap();
    let destination = local.path().join("cancelled");
    let error = transfer_session(
        session.clone(),
        TransferInput {
            id: Some("cancel-me".into()),
            direction: Direction::Download,
            source: "/source".into(),
            destination: destination.to_str().unwrap().into(),
        },
        |progress| {
            assert_eq!(progress.bytes, 0);
            assert!(!cancel_session_transfer(&session, "another-id").unwrap());
            assert!(cancel_session_transfer(&session, &progress.id).unwrap());
        },
    )
    .unwrap_err();
    assert_eq!(error, CANCELLED);
    assert!(!destination.exists());
    assert_eq!(fs::read_dir(local.path()).unwrap().count(), 0);
    assert!(session_info(&session).unwrap().is_none());
    assert!(session.remote.lock().unwrap().is_none());
    assert!(!cancel_session_transfer(&session, "cancel-me").unwrap());
    assert!(list_remote_session(&session, "/")
        .unwrap_err()
        .contains("Connect to a server first"));
    connect_session(session.clone(), connection(port, false)).unwrap();
    assert!(list_remote_session(&session, "/").is_ok());
}

#[test]
#[ignore = "Requires BFTP_TEST_PYTHON with pyftpdlib; opens loopback ports"]
fn dropped_server_cleans_partial_download_and_session() {
    let remote = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    File::create(remote.path().join("large"))
        .unwrap()
        .set_len(64 * 1024 * 1024)
        .unwrap();
    let (mut fixture, port) = fixture(remote.path(), None);
    let session = Session::default();
    connect_session(session.clone(), connection(port, false)).unwrap();
    let destination = local.path().join("failed");
    let error = transfer_session(
        session.clone(),
        TransferInput {
            id: Some("drop-me".into()),
            direction: Direction::Download,
            source: "/large".into(),
            destination: destination.to_str().unwrap().into(),
        },
        |_| {
            let _ = fixture.0.kill();
            let _ = fixture.0.wait();
        },
    )
    .unwrap_err();
    assert!(error.contains("Connection closed"), "{error}");
    assert!(!destination.exists());
    assert_eq!(fs::read_dir(local.path()).unwrap().count(), 0);
    assert!(session_info(&session).unwrap().is_none());
    assert!(session.remote.lock().unwrap().is_none());
}

#[test]
#[ignore = "Requires BFTP_TEST_PYTHON with pyftpdlib, pyopenssl, and openssl CLI"]
fn rejects_untrusted_ftps_certificate() {
    let remote = tempfile::tempdir().unwrap();
    let cert = remote.path().join("server.pem");
    let key = remote.path().join("key.pem");
    assert!(Command::new("openssl")
        .args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout"])
        .arg(&key)
        .arg("-out")
        .arg(&cert)
        .args(["-days", "1", "-subj", "/CN=localhost"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success());
    let mut pem = fs::read(&cert).unwrap();
    pem.extend(fs::read(&key).unwrap());
    fs::write(&cert, pem).unwrap();
    let (_fixture, port) = fixture(remote.path(), Some(&cert));
    let error = connect_session(Default::default(), connection(port, true))
        .err()
        .expect("Untrusted self-signed certificate must fail");
    assert!(error.contains("Secure connection failed"), "{error}");
}
