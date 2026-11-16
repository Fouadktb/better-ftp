# Contributing

Better FTP is an alpha. Start with the [delivery plan](docs/PLAN.md) and keep a change small enough to review and verify independently. Bug reports should include the operating system, app revision, protocol, steps, expected behavior, and actual result. Redact hosts, usernames, passwords, keys, and private file paths from logs and screenshots.

## Development setup

Install Node.js 24 LTS, stable Rust, and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

```sh
npm ci
npm run desktop
```

The desktop runtime is required for filesystem and protocol operations. The frontend development server alone must display native-runtime unavailability instead of simulating a connection or successful transfer.

## Change boundaries

- Keep privileged filesystem, network, and credential work in Rust. Expose narrow typed commands and validate inputs at the native boundary.
- Keep connection, directory, profile, and transfer lifecycle logic separate from workspace markup. Prefer small hooks/services and reusable presentation primitives over adding more state coordination to `App.tsx`.
- Follow a compact tool layout inspired by T3 Code and shadcn conventions: clear focus, predictable controls, readable file rows, and concise operational status. Avoid promotional copy, redundant page titles, and decorative panels that displace file content.
- Production adapters contain no sample filesystem, fake server, simulated delay, or success fallback. Tests inject command fixtures through the harness; fixture modules must not enter the production bundle.
- Associate work with a connection/session identity. Ignore stale directory and transfer results after disconnect, replacement, or unmount. Transfers must never execute against a different server than the one selected when queued.
- Do not persist passwords in profiles, queue records, logs, or error output. Do not add certificate or SSH host-key bypasses.
- Treat overwrite, delete, synchronization, and retry semantics as behavior changes requiring explicit review. Do not silently weaken no-clobber behavior.

## Verification

Run checks relevant to the change and report the commands and results in the pull request:

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
```

Frontend interaction fixtures should be installed before app startup and exercise the production adapter boundary. Use controllable deferred responses to test races: disconnect during listing, quick successive navigation, transfer completion while navigation is pending, queued cancellation, pause/resume, and session replacement. Keep an unmocked browser check proving native operations are unavailable outside Tauri.

Protocol changes also need disposable loopback-server tests; see the [README](README.md#verify). Check binary integrity, Unicode paths, conflicts, denied access, interrupted connections, and certificate failures as applicable. Real test-server credentials stay outside the repository. Browser fixture passes cannot substitute for native UI and real-protocol smoke tests.

Explain any checks you could not run. Cross-platform claims require evidence from the corresponding operating system. Document remaining release gates instead of inferring a pass from another platform.

## Pull requests

Describe the concrete problem, resulting behavior, and relevant validation. Include before/after screenshots for meaningful UI changes and identify any remaining limitations. Update the README or plan when a supported capability or release gate changes. Do not include unrelated generated output or secrets.

## License

Better FTP is released under the [MIT license](LICENSE). Contributions are provided under the same license.
