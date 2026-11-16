# Release preparation

Release preparation creates reviewable installers and a draft prerelease. Publishing a GitHub release remains a separate maintainer action. The workflow does not publish automatically, create a missing tag, or enable an updater.

## Current readiness

The repository destination is [Fouadktb/better-ftp](https://github.com/Fouadktb/better-ftp), selected by the owner with the [MIT license](../LICENSE). The first prerelease version is `0.1.0-alpha.1`. Package, lockfile, Tauri, and Cargo versions are synchronized.

Local alpha validation covers frontend tests/build and native macOS FTP/SFTP integration. GitHub installer builds and platform smoke results are recorded separately; creating a draft does not imply signing or production readiness.

## Version source

`package.json` is the single source of the application version. Edit its `version` field, then run:

```sh
node scripts/sync-version.mjs
node scripts/sync-version.mjs --check
node --test scripts/sync-version.test.mjs
```

The script accepts SemVer release and prerelease versions without a `v` prefix. It synchronizes the root versions in `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the local application entry in `src-tauri/Cargo.lock`. It does not change dependency versions or regenerate lockfiles. `--check` is read-only and fails on inconsistency, invalid SemVer, missing root entries, or unexpected package identity. Fixture tests use temporary directories and do not change the working tree's version.

The release workflow accepts prerelease versions only. Its tag must be exactly `v` plus the package version, for example `v0.1.0-alpha.1`. Tag pushes with a mismatching version fail before building. Build metadata may be valid SemVer but should be avoided in installer releases until each platform's version handling is tested.

## Gates before tagging

- Owner-selected license, repository destination, release name, application identifier, and distribution ownership are reviewed.
- All version files agree and lockfiles are committed. Update `CHANGELOG.md` with a versioned scope and known limitations.
- Frontend formatting, unit tests, interaction tests, production build, native compilation, and Rust tests pass at the exact release commit. CI invokes the version script and its regressions.
- Real disposable protocol fixtures pass, including binary roundtrips, conflicts, authentication failures, certificate validation, permission failures, interrupted transfers, and cancellation where supported. SFTP requires its own key/password, unknown/changed-host-key, and transfer fixtures before the release claims support.
- Native UI smoke tests exercise connect, navigation, upload/download, errors, disconnect/reconnect, and window close during work. Browser fixtures cannot substitute for real native/protocol testing.
- Install, launch, transfer, and uninstall are tested on Windows, Linux, Intel macOS, and Apple Silicon macOS using the actual installers. A successful macOS build alone is insufficient evidence for other platforms.
- Review credentials/logging, persisted profile contents, accessibility, dependency licenses, artifact contents, and signing status. Keep unresolved checks visible in release notes; do not label the alpha stable or production-ready.

The reusable Checks workflow runs frontend checks, a three-OS Rust check/test matrix, and Linux loopback FTP/FTPS/SFTP fixtures, including password, encrypted-key, agent, host-key and fault checks. Native installer/UI smoke tests and legal/signing review remain maintainer gates.

## Workflow behavior

[release.yml](../.github/workflows/release.yml) is based on the official [Tauri GitHub pipeline](https://v2.tauri.app/distribute/pipelines/github/) and [tauri-action inputs](https://github.com/tauri-apps/tauri-action). Action references are pinned to verified commit SHAs. Review them when upgrading dependencies or runner images.

- A pushed prerelease tag (`v*-*`) validates the version and existing tag, runs Checks, builds every installer target, and assembles a **draft prerelease** only after all builds succeed.
- A manual run builds the selected branch/tag commit. Its default is **artifacts only**. Enabling `create_draft` additionally requires an already existing matching tag on that exact commit and a project license file. The workflow never creates a missing tag.
- Artifact-only runs also require a prerelease version. They are useful before tagging, after the local version is prepared and committed to the chosen ref.
- Linux x64 produces `.deb` and `.AppImage`; Windows x64 produces NSIS `.exe`; Apple Silicon and Intel macOS each produce a `.dmg`. Other architectures are not covered. MSI is deferred: [Tauri's WiX conversion](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/msi/mod.rs) rejects a nonnumeric prerelease identifier such as `alpha.1` without an explicit WiX version override. Design and test that numeric mapping and upgrade ordering before adding MSI to the alpha matrix.
- Installer artifacts are retained for 14 days. The draft job flattens filenames, refuses collisions, adds `SHA256SUMS`, and uploads the installers. Checksums detect changed downloads; they are not signing identities.
- Only the final draft job receives `contents: write`, using GitHub's built-in `GITHUB_TOKEN`. Builds and tests have read-only repository permission and no signing credentials. The workflow refuses to replace a published release. Reruns can replace assets on an existing draft.

Maintainer steps, once the owner authorizes the repository and release:

1. Commit version, changelog, license, workflow, and application changes; run the release gates.
2. Configure the intended GitHub remote and push the reviewed commit. Confirm Actions and the token's release permission are allowed for that repository.
3. Run the manual workflow with `create_draft` disabled to review build results before creating a tag.
4. Create the matching annotated prerelease tag on the reviewed commit and push it. Tagging/pushing is an explicit release action, not part of local preparation.
5. Inspect every installer and checksum, test clean installation on each target, and edit the draft notes to record actual validation and unsigned/notarized status.
6. Publish the draft only when the owner authorizes publication and the remaining gates are satisfied. Retain the prerelease flag for alpha builds.

## Signing and notarization

The prepared workflow deliberately does not invent or reference unavailable signing secrets. Windows/Linux artifacts are unsigned. On macOS it sets the documented ad-hoc identity (`APPLE_SIGNING_IDENTITY=-`) so the application has an ad-hoc signature; this does not establish developer identity, notarization, or Gatekeeper trust. Alpha notes must state these limits. Do not tell users to disable operating-system protection to install it.

For a signed macOS release, provision the owner's Developer ID Application identity and protected CI certificate material, configure Tauri's signing identity, and use an authorized notarization method. Follow [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/), verify the resulting signature, notarization, and stapled ticket, and test the downloaded DMG on a clean machine. Ad-hoc signing is not a replacement for these steps.

For Windows, choose the owner's supported certificate or signing service and configure it using [Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/) and that provider's current guidance. Validate signatures and timestamps on both the application and installers. Signing does not guarantee immediate SmartScreen reputation.

Keep signing credentials in protected repository/environment secrets after the signing method is chosen. Do not commit them or expose them to pull-request jobs. Updater signing is a separate design and credential lifecycle; no updater manifest or signatures are produced by this workflow.
