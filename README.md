<img src="assets/app-icon.png" width="72" height="72" alt="Better FTP icon">

# Better FTP

A desktop FTP, FTPS, and SFTP client built with Rust, Tauri 2, React, and TypeScript. Targets Windows, macOS, and Linux.

**Version:** `0.1.0-alpha.3` · **License:** [MIT](LICENSE) · **Repository:** [Fouadktb/better-ftp](https://github.com/Fouadktb/better-ftp)

Download the latest alpha installers from [GitHub Releases](https://github.com/Fouadktb/better-ftp/releases). This is an alpha, not a stable replacement yet. See the [FileZilla comparison](docs/FILEZILLA_COMPARISON.md), [delivery plan](docs/PLAN.md), and [release process](docs/RELEASING.md) for scope and remaining gates.

## Run from source

Install Node.js 24 LTS, stable Rust, and your platform's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run desktop
```

Linux needs WebKitGTK 4.1 and related development libraries; Windows needs the C++ build tools and WebView2; macOS needs Xcode command line tools. The SSH library builds a vendored OpenSSL backend, which also requires the native compiler and Perl toolchain. Add `$HOME/.cargo/bin` to your shell PATH if Cargo is not found.

`npm run dev` serves the frontend at http://127.0.0.1:1420. File access and connections require the desktop runtime. The browser does not substitute sample files or simulated transfers; interaction tests inject their fixtures separately.

## Connections

Choose **New connection** and set protocol, host, port, username, and authentication:

**Abort connection** stops connection setup and keeps your form edits for retry. The toolbar provides **Disconnect** and **Reconnect**; reconnect restores the last server settings and asks for a fresh password or key passphrase. Finish or cancel pending transfers before disconnecting or reconnecting.

| Protocol           | Default port | Authentication                                                       |
| ------------------ | ------------ | -------------------------------------------------------------------- |
| SFTP over SSH      | 22           | Password, private key with optional passphrase, or running SSH agent |
| FTPS, explicit TLS | 21           | Username and password                                                |
| FTP, unencrypted   | 21           | Username and password                                                |

- SFTP verifies the server key **before authentication**. First-use trust requires a SHA256 fingerprint confirmation. Changed keys block connection; there is no accept-all bypass. Trust is rechecked during the actual connection handshake.
- SSH trust entries live in `known_hosts` under the application's platform configuration directory. The app does not modify your global SSH files. Replacing a changed key currently requires deliberate manual management of that app-owned file after verifying the server.
- Key authentication supports OpenSSH/PEM private keys, including encrypted Ed25519 keys. Passwords and key passphrases remain in session memory and are never saved in profiles or queues.
- The **Directories** tab stores optional starting local and remote folders. **Advanced** configures the actual network timeout (1–300 seconds). New SFTP connections default to port 22; switching protocols updates only a default port, preserving custom ports.
- Profiles store only connection metadata. Legacy FTP/FTPS profiles migrate from the old encryption flag without changing their protocol.
- Clicking outside, pressing Escape, or closing a clean connection form dismisses it. Unsaved changes require a discard decision; keeping edits preserves all values. An in-progress connection cannot be dismissed accidentally.

Keyboard-interactive/MFA, SSH config/ProxyJump, implicit FTPS, and OS credential storage are not implemented. An SSH agent must already be running with an authorized key loaded. GUI applications launched from the desktop may have different agent environments from your terminal.

## File and transfer behavior

- Local/remote file panes with editable paths, history, parent navigation, refresh, filtering, sorting, hidden files, and multiselection.
- Resizable work areas and a docked queue/activity log, keyboard controls, and light/dark themes following the OS.
- Streamed single-file upload/download with measured byte progress, live rolling speed, completed-file average speed, pause between jobs, retry, and active/waiting cancellation.
- SFTP upload uses server-side exclusive create. Downloads use a temporary sibling file and atomic no-clobber save. FTP uploads check names before `STOR`; a cross-client race remains, so atomic remote no-overwrite is not claimed for FTP/FTPS.
- Newly created SFTP files use owner read/write permissions (`0600`). Existing remote files are refused rather than replaced.
- Cancelling or failing an in-flight transfer closes an uncertain connection before further work. Temporary downloads are removed; partial uploads may remain on the server.
- Native window close and macOS application-menu Quit confirm pending work. Dock Quit, forced termination, and OS shutdown are outside the verified guard scope.

Transfers are serial and share the browsing connection. Native session metadata can restore the connected endpoint and working directory after webview reload; queue history is not durable. Recursive folder transfers, mkdir/rename/delete, drag/drop, overwrite resolution, resume, concurrency, speed limits, synchronization, remote editing, signed installers, and automatic updates remain roadmap work.

## Verify

```sh
npm run version:check
npm run test:release
npm run format:check
npm test
npx playwright install chromium
npm run test:e2e
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked --all-targets
```

Full protocol tests use disposable loopback servers, not public services:

```sh
python3 -m venv /tmp/better-ftp-tests
/tmp/better-ftp-tests/bin/pip install -r src-tauri/tests/requirements.txt
BFTP_TEST_PYTHON=/tmp/better-ftp-tests/bin/python cargo test --manifest-path src-tauri/Cargo.toml --locked --lib -- --include-ignored
```

These tests also require `openssl`, `ssh-keygen`, and (on Unix) `ssh-agent`/`ssh-add`. They cover FTP and real authenticated SFTP transport, password/encrypted-key/agent authentication, unknown/changed host keys, binary integrity, no-clobber behavior, measured progress, cancellation/reconnect, dropped connections, and untrusted FTPS rejection. A positive trusted-certificate FTPS transfer remains a release gate.

Build current-platform installers with `npm run desktop:build`; macOS app only: `npm run desktop:build -- --bundles app`. GitHub Actions prepares Windows NSIS, Linux DEB/AppImage, and Intel/ARM macOS DMG artifacts for review. Alpha installers are not publicly signed/notarized. Draft releases require exact version tags and successful checks/builds; publication is a separate maintainer action.

## Source layout

- `src/App.tsx`: workbench composition and view controls.
- `src/state/`: session/navigation/queue controller, React subscription, and native close guard.
- `src/components/`: panes, connection settings, host-key confirmation, queue, and UI primitives.
- `src/bridge.ts`: typed native commands and native file selection.
- `src/model.ts`, `src/lib/`: profile migration, data types, paths, sorting, and transfer-rate measurement.
- `src-tauri/src/`: protocol boundary, FTP, SSH/SFTP, transfer engine, native commands, and tests.
- `tests/`, `e2e/`, `src-tauri/tests/`: model/lifecycle, injected-interface, and real-protocol checks.
- `scripts/`, `.github/`: version synchronization, checks, and draft release packaging.
- `assets/`: [app icon master and generation notes](assets/README.md).

The workbench takes structural inspiration from [T3 Code](https://github.com/pingdotgg/t3code) and [shadcn/ui](https://ui.shadcn.com/docs/theming). Dialogs, menus, tooltips and tabs use Radix primitives; native operations stay behind [Tauri commands](https://v2.tauri.app/develop/calling-rust/). See [CONTRIBUTING.md](CONTRIBUTING.md) for contributor setup and review boundaries.
