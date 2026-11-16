# Changelog

## Unreleased

## 0.1.0-alpha.1 — 2026-11-16

First alpha. Installer builds and platform smoke tests remain release gates; this is not a stable release.

### Added

- Rust/Tauri workbench with local/remote panes, saved profiles, directory history, filtering/sorting, multiselection, resizable work areas, and light/dark themes.
- FTP, explicit FTPS, and SFTP single-file browsing/transfers.
- SFTP password, encrypted private-key, and SSH-agent authentication; SHA256 first-use trust and changed-key blocking before credentials are sent.
- Per-connection starting directories and network timeout, native key/folder selection, automatic default ports, and migration of legacy FTP/FTPS profiles.
- Serial transfer queue with measured progress and speed, completed averages, cancellation, pause, retry, and activity log.
- Guarded unsaved connection dismissal and native transfer-aware window close/macOS Quit.
- Dedicated application icon, MIT license, synchronized SemVer, cross-platform checks, and draft prerelease installer workflow.
- Model/controller, interface, versioning, and actual loopback FTP/SFTP integration tests.

### Known limitations

- No keyboard-interactive/MFA, ProxyJump, SSH config import, or host-key replacement UI.
- No recursive transfers, mkdir/rename/delete, conflict replacement/rename flow, concurrency, speed limiting, resume, durable queue, sync, or remote editing.
- SFTP exclusive-create uploads and local download no-clobber are enforced. FTP listing-then-STOR still has a cross-client collision race.
- Cancelled uploads may leave partial remote files. New SFTP files use `0600` permissions.
- Windows/Linux and Intel macOS installer execution, trusted-certificate FTPS transfer, and formal accessibility/performance review remain release gates.
- Alpha installers are unsigned on Windows/Linux and ad-hoc signed on macOS, without Developer ID signing or notarization. No automatic updater.
