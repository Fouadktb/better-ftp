# Better FTP delivery plan

The first milestone is a useful native file-transfer client with explicit protocol support and trustworthy operational state. It is an alpha for testing; later phases close the remaining daily-use and distribution gaps.

## Architecture

- Tauri 2 desktop shell, React/TypeScript interface, Vite build.
- Privileged filesystem and protocol operations live in Rust. `RemoteClient` separates FTP/FTPS and SSH/SFTP from the streaming transfer engine.
- A React-independent controller owns connection identity, directory request revisions, saved profiles, and serial queue transitions. Transfer completion cannot override newer navigation; late responses cannot replace a newer session.
- Production uses native commands exclusively. Browser tests inject fixtures at the harness boundary; the product contains no sample filesystem or simulated transfer mode.
- Profiles contain whitelisted metadata. Passwords, passphrases and private-key contents are not persisted. Actual SSH handshake verification precedes authentication; certificate/host-key bypasses are unsupported.
- A measured-byte rate meter supplies rolling live throughput and completed averages. Cancellation interrupts network sockets and discards uncertain sessions.
- `package.json` is the version source; the version script synchronizes Cargo, Tauri and lockfile versions. Installer CI creates draft prereleases only.

## Milestone 1 — 0.1.0-alpha.1

**Status: implemented and locally verified on macOS; GitHub platform checks and installer validation are separate release gates.**

Delivered:

- Local/remote panes, path/history navigation, refresh, filtering, sorting, hidden files, multiselection, keyboard controls, resizable layout and docked queue/log.
- FTP, explicit FTPS, and SFTP single-file listing/upload/download.
- SFTP password, encrypted private-key and SSH-agent authentication. Unknown SSH keys require SHA256 fingerprint confirmation. Changed keys are blocked. Known-host writes are atomic and locked; no global SSH files are modified.
- Connection settings for protocol-specific default ports, authentication, native key/folder selection, default local/remote directories and actual network timeout.
- Legacy FTP/FTPS profile migration with unchanged protocol semantics and credential-free persistence.
- Serial queue, measured progress/live speed, completed averages, pause, retry, active/waiting cancellation and session recovery metadata.
- SFTP exclusive-create uploads; atomic no-clobber local downloads; explicit FTP listing-then-STOR collision limitation.
- Unsaved-form discard guard, focus preservation, and native transfer-aware window close/macOS application-menu Quit.
- Dedicated desktop icon, MIT license, public repository, synchronized alpha version, contributor/release documentation and cross-platform artifact workflow.

Local verification:

- 52 model/controller/throughput/profile tests.
- 24 desktop/mobile Playwright scenarios, including native-runtime absence, transfers/conflicts/cancellation, light/dark layout, resize and keyboard controls, guarded dismissal, protocol/default/custom ports, key/folder selection, saved settings, first-use trust and changed-key blocking.
- Three version-sync fixture regressions and real-tree consistency check.
- 13 Rust tests with actual authenticated loopback SSH/SFTP and FTP/FTPS fault fixtures: password, encrypted Ed25519 key and isolated SSH-agent auth, unknown/changed host keys, fingerprint revalidation, canonical directories, binary roundtrips, exclusive/no-clobber behavior, byte progress, cancellation/reconnect, dropped connections and untrusted FTPS rejection.
- Production frontend build, Rust formatting and Clippy with warnings denied, and macOS application bundling.
- Packaged native UI: actual FTP and SFTP connect/list/upload/download, byte-for-byte file integrity, first-use SHA256 comparison against the test server, guarded exit and unsaved-form confirmation. Native UI tests use disposable loopback fixtures.

Remaining release gates:

- Execute Windows/Linux and Intel/ARM macOS artifact builds and test installation, launch, transfers and uninstall on those targets.
- Positive FTPS transfer against a trusted certificate, denied-permission fixtures, formal accessibility review and large-directory/queue performance budgets.
- Review third-party license notices and signing/notarization before public distribution. Alpha artifacts remain unsigned on Windows/Linux and ad-hoc signed on macOS.
- Dock Quit, forced termination and OS shutdown remain outside the verified close guard.

## Milestone 2 — Daily file operations

Add recursive folder transfers, mkdir/rename/delete, conflict decisions (skip, rename and explicit replace), bookmarks and drag/drop. Add keyboard-interactive/MFA and host-key replacement management after designing explicit trust transitions.

Acceptance:

- Traversal defines symlink and permission behavior and prevents destination path escape.
- Destructive actions are deliberate, reviewable and accurately logged. Existing-file decisions show source/destination metadata.
- Tests cover nesting, Unicode, case sensitivity, empty/large files, denied access, partial failure and cancellation.
- SSH config/proxy/ProxyJump support is a separately scoped connection feature; do not expose nonfunctional settings.

## Milestone 3 — Transfer reliability and performance

Add a bounded transfer pool with a separate browsing connection, per-server budgets, reconnect/retry policy, durable queues, resume where safe, and speed limits. Add OS credential storage as an explicit user choice.

Acceptance:

- Transfers remain bound to their intended endpoint through reconnect/restart, with fresh authentication and no secrets in queue records.
- Retry does not loop authentication failures or silently replace partial/existing destinations.
- Resume validates the existing data and requires a decision if safe continuation cannot be established.
- Interrupted networks, server/app restarts, disk exhaustion, worker cancellation and large directories have measured behavior and deterministic tests.
- Credentials can be removed from the platform store and are excluded from exports/logs.

## Milestone 4 — Advanced workflows

Directory comparison/synchronization, synchronized navigation, remote editing and transfer rules follow a reviewed design.

Acceptance:

- Sync offers a dry-run plan with uploads, downloads, conflicts and deletions before execution.
- Timestamp/checksum assumptions are documented; conflict handling protects externally modified files.
- Tests cover time zones, timestamp precision, case sensitivity, symlinks and partial execution.

## Distribution and stable release

Every milestone produces a versioned, reviewable build. Stable release requires recorded platform smoke tests, signed/notarized installers as appropriate, dependency/license and accessibility review, and demonstrated recovery behavior. An updater is a separate signed-update design. The [FileZilla comparison](FILEZILLA_COMPARISON.md) tracks capability gaps; the [release guide](RELEASING.md) defines version, artifact and publication procedures.
