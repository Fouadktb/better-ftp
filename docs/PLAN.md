# Better FTP delivery plan

Better FTP is a desktop file transfer client for Windows, macOS, and Linux. Its first release should make connecting, browsing, and transferring files understandable and dependable. Later phases add protocol coverage and advanced automation without compromising that workflow.

## Architecture

- **Desktop shell:** Tauri 2, with platform integration and privileged operations in Rust.
- **Interface:** React, TypeScript, and Vite. A dual-pane workspace presents local and remote directories, connection profiles, and a visible session transfer queue (durable persistence arrives in phase 3).
- **Rust backend:** owns local filesystem access, FTP/explicit FTPS sessions, directory listings, and transfers. Passwords remain in session memory for phase 1 and are excluded from saved profiles and application logs.
- **Frontend boundary:** typed commands and results isolate desktop operations from UI state. The production adapter uses native commands exclusively. A browser without the native runtime shows an unavailable state; it does not supply files, a connection, or simulated transfer success. Test fixtures are injected by the test harness and excluded from the production adapter.
- **Frontend structure:** separate connection, directory, profile, and transfer lifecycle hooks from native services and presentation. Shared button, input, dialog, and table primitives provide consistent interaction. Follow the compact utility-first interaction patterns of T3 Code and shadcn: file content, connection controls, and transfer state take precedence over decorative headings or promotional copy. Session/navigation/queue state now lives in a React-independent controller with deterministic deferred-response tests.
- **Transfer model:** a serial queue in phase 1, with explicit queued, active, completed, failed, and cancelled states as supported by the implementation. Capabilities are exposed honestly; a control must not promise an operation the backend cannot perform.
- **Delivery model:** each phase ends with an executable, reviewable milestone and a recorded verification result. A scaffold or passing frontend build alone does not establish native or protocol correctness.

## Phase 1 — Working foundation

**Status: revised alpha implemented and locally verified on macOS; platform and remaining protocol gates are open.**

Deliver a useful end-to-end desktop slice: real local browsing, real FTP and explicit FTPS browsing and file transfers, dual panes, saved connection metadata, and a serial transfer queue. Ship only real native operations. Keep deterministic test fixtures in the test harness, with no product demo mode or sample server.

Acceptance criteria:

- Local and remote panes have independent paths, parent navigation, refresh, sorting, filtering, selection, loading, empty, and error states.
- Users can create, edit, select, and delete connection profiles. Profiles record the protocol, host, port, username, and name; saved data contains no password.
- A connection shows server identity, chosen protocol, connecting/connected/error states, and an explicit disconnect action. Plain FTP visibly identifies its unencrypted transport.
- Desktop FTP and explicit FTPS can list directories and transfer an individual file in either direction. FTPS validates the server certificate; certificate failures are surfaced, not silently bypassed.
- Transfers run serially and show direction, filename, status, progress when available, and actionable errors. An unsuccessful operation cannot appear completed. Known conflicts are refused. Local downloads guarantee no-clobber persistence; FTP upload listing-then-STOR has a cross-client race that must be resolved before claiming atomic no-overwrite behavior.
- Long operations do not freeze the workspace. Passwords do not appear in logs, persisted profiles, queue entries, or error messages.
- Connection and directory state have explicit lifecycle identities. Disconnect, reconnect, unmount, and newer navigation invalidate stale async results. A transfer completion cannot navigate the user back to an earlier directory.
- Queue transitions have one owner. Starting a file, cancelling a waiting file, pausing, retrying, and completing a file are tested against concurrent UI events. Transfers belong to a specific connection session and cannot run against a replacement session.
- Enqueue validates both source and destination availability. Busy or failed directory views cannot silently become transfer destinations. The app documents and tests what happens when its window closes during an active transfer.
- Keyboard access, visible focus, labeled icon controls, accessible dialogs, readable contrast, and usable narrow-window behavior are part of the slice.

Verification and release gate:

- Frontend type checking and production build pass. Meaningful unit tests cover path handling, profile persistence without credentials, queue state transitions, and failures.
- Rust formatting, compilation, linting, and relevant tests pass in an environment with the Rust toolchain and required Tauri platform dependencies.
- Integration checks use disposable FTP and explicit FTPS servers: connect, list, upload, download, binary integrity, invalid credentials, invalid certificate, missing paths, permission errors, disconnect, and transfer failure.
- A native smoke test exercises the real filesystem and protocol boundary. Browser interaction tests inject native-command fixtures before app startup; they test the same production UI without adding a runtime test/demo selector. An unmocked browser check verifies that native operations remain unavailable.
- Deferred-response tests cover disconnect during listing, connection replacement, rapid navigation, transfer completion during navigation, pause/start/cancel transitions, unmount, and stale-session rejection.
- Record unavailable checks and known limitations. Do not mark phase 1 complete until its native and protocol gates have actually passed.

## Phase 2 — Secure connections and everyday transfers

Add SFTP, operating-system credential storage, SSH host-key verification, recursive folder transfers, bounded concurrency, and explicit overwrite/skip/rename conflict handling. Preserve directory context across reconnects.

Acceptance and testing gate:

- SFTP distinguishes first-use and changed host keys; changed keys cannot be accepted silently. Password and key authentication follow explicit user choices.
- Credentials are stored through an appropriate platform credential service, excluded from profile exports, and removable by the user.
- Folder traversal defines symlink and permission behavior and prevents destination path escape. Cancelling work stops ongoing operations and leaves queue state accurate.
- Protocol integration tests cover nested directories, Unicode and spaces, zero-byte and large files, denied access, partial failures, conflicts, and cancellation. Each supported platform validates credential storage and native interaction.

## Phase 3 — Recovery and transfer reliability

Add persistent queues, reconnect and retry policies, safe resume where the server and protocol support it, bandwidth and concurrency controls, and diagnostics that redact secrets.

Acceptance and testing gate:

- Restarting the app preserves eligible queued work without silently resuming a destructive operation or persisting credentials in the queue.
- Resume validates the existing destination and falls back to an explicit user decision when safe continuation cannot be established.
- Interrupted networks, server restarts, app restarts, disk exhaustion, and partial destination files have tested recovery behavior. Completed-file integrity is verified in the test suite.
- Stress tests cover large directories and long queues; performance budgets are measured and documented before release.

## Phase 4 — Advanced file workflows

Add directory comparison and synchronization, synchronized browsing, bookmarks, remote editing, and configurable transfer rules. Scheduling and unattended automation require a separate design and explicit user control.

Acceptance and testing gate:

- Sync starts with a reviewable plan listing uploads, downloads, conflicts, and deletions. Destructive changes require a deliberate action.
- Comparisons document timestamp, size, and checksum assumptions. Dry-run and execution agree on a controlled test fixture.
- Remote editing identifies external changes and obtains an explicit decision before replacing conflicting content.
- Tests cover timestamp precision, time zones, case sensitivity, symlinks, changed remote files, and partial sync failures.

## Phase 5 — Distribution and stable release

Produce installable, signed releases for Windows, macOS, and Linux, with documented prerequisites, upgrade behavior, release notes, and a supported-platform matrix.

Acceptance and release gate:

- CI builds and tests the native app on every supported operating system. Installation, launch, connection, transfer, upgrade, and uninstall are smoke-tested using packaged artifacts.
- macOS signing/notarization, Windows signing, and selected Linux package formats are verified before public distribution. Release credentials remain outside the repository.
- An update mechanism, if enabled, validates signed updates and has tested failure behavior.
- Accessibility and keyboard review, credential and logging review, crash recovery, dependency license checks, and protocol compatibility checks have recorded outcomes.
- Publish only capabilities that passed the release gates, with known limitations and recovery instructions included in the release notes.

## Working approach

The primary agent owns integration and the acceptance gates. Parallel sub-agents take bounded architecture, backend, frontend, or review tasks with explicit file ownership. Findings are reconciled before a milestone is declared complete. Changes stay independently reviewable; a later phase does not conceal unresolved correctness failures from an earlier one.

## Verification record — 2026-11-16

Passed on macOS after the production refactor:

- TypeScript and production frontend build; exact tested JavaScript dependency versions and lockfile included in the source tree.
- 47 model/controller and throughput tests covering Windows roots, directory filtering/sorting, session replacement, late directory responses, completion during navigation, transfer eligibility, serial execution, pause/cancel, stale cancellation responses, measured completion bytes, relative remote paths, recovery fencing, close waiting, credential-free profile persistence, rolling throughput, and stalled-transfer rate decay.
- 18 Playwright scenarios across desktop/mobile, including an unmocked unavailable-runtime check. Native fixtures are injected only by the harness. The scenarios cover real product controls, both transfer directions, conflicts, cancellation/disconnection, light/dark themes, resizing, keyboard-operated tabs, real-time rate display, guarded connection dismissal, unchanged/reverted form detection, and protection during pending connections.
- Eight Rust tests including actual loopback FTP binary roundtrip, Unicode names, no-clobber checks, invalid credentials, measured progress, session metadata and canonical paths, cancellation/reconnect, dropped-server cleanup, and untrusted FTPS certificate rejection.
- Rust formatting and Clippy with warnings denied.
- macOS release application package built. Native UI connected to a disposable loopback FTP server, uploaded and downloaded files; file contents matched at both ends. A throttled transfer displayed actual progress and Cmd+Q opened the transfer-confirmation dialog. Keeping the app open preserved the transfer; cancellation closed the connection and the corrected cancel-and-close path exited the app. The rebuilt native dialog also warned on outside click, preserved values with Keep editing, and discarded only after confirmation. Temporary test connection profiles were removed afterward.

Remaining release gates: positive FTPS transfer with a trusted certificate, denied-permission fixtures, formal accessibility review, large-directory performance, and Windows/Linux execution of the configured CI matrix. Dock Quit, forced termination, and operating-system shutdown are outside the verified close-guard scope. FTP upload listing-then-STOR still has a cross-client collision race; atomic remote no-overwrite is not claimed. SFTP, recursive transfers, durable queues, resume, signed releases, and license selection remain on the roadmap.
