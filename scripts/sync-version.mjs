import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const numeric = '(?:0|[1-9][0-9]*)';
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const semver = new RegExp(
  `^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

export function validateVersion(version) {
  if (typeof version !== 'string' || !semver.test(version)) {
    throw new Error(
      'package.json version must be valid SemVer, without a v prefix or leading zeroes.',
    );
  }
  return version;
}

function replaceTomlVersion(text, start, end, version, file) {
  const section = text.slice(start, end);
  const matches = [...section.matchAll(/^version\s*=\s*"([^"]+)"/gm)];
  if (matches.length !== 1) throw new Error(`Expected one explicit version in ${file}.`);
  return {
    version: matches[0][1],
    text:
      text.slice(0, start) +
      section.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`) +
      text.slice(end),
  };
}

export async function syncVersions(root, { check = false } = {}) {
  const files = [
    'package.json',
    'package-lock.json',
    'src-tauri/tauri.conf.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
  ];
  const contents = await Promise.all(files.map((file) => readFile(resolve(root, file), 'utf8')));
  const pkg = JSON.parse(contents[0]);
  const version = validateVersion(pkg.version);
  if (typeof pkg.name !== 'string' || !pkg.name)
    throw new Error('package.json must have a package name.');
  const lock = JSON.parse(contents[1]);
  if (!lock.packages?.[''] || lock.packages[''].name !== pkg.name || lock.name !== pkg.name) {
    throw new Error('package-lock.json must contain the matching root package.');
  }
  const config = JSON.parse(contents[2]);
  const manifest = contents[3];
  const packageHeader = /^\[package\]\s*$/m.exec(manifest);
  if (!packageHeader) throw new Error('Cargo.toml must have a [package] section.');
  const packageStart = packageHeader.index + packageHeader[0].length;
  const nextSection = /^\[/m.exec(manifest.slice(packageStart));
  const packageEnd = nextSection ? packageStart + nextSection.index : manifest.length;
  const packageSection = manifest.slice(packageStart, packageEnd);
  if (
    !packageSection
      .split(/\r?\n/)
      .some((line) => line.trim() === `name = ${JSON.stringify(pkg.name)}`)
  ) {
    throw new Error('Cargo.toml package name must match package.json.');
  }
  const cargo = replaceTomlVersion(
    manifest,
    packageStart,
    packageEnd,
    version,
    'Cargo.toml [package]',
  );
  const cargoLock = contents[4];
  const blocks = [
    ...cargoLock.matchAll(/^\[\[package\]\][\s\S]*?(?=^\[\[package\]\]|$(?![\s\S]))/gm),
  ];
  const roots = blocks.filter(
    (block) =>
      block[0]
        .split(/\r?\n/)
        .some((line) => line.trim() === `name = ${JSON.stringify(pkg.name)}`) &&
      !/^source\s*=/m.test(block[0]),
  );
  if (roots.length !== 1)
    throw new Error('Cargo.lock must contain exactly one local root package.');
  const cargoLockRoot = roots[0];
  const cargoLockResult = replaceTomlVersion(
    cargoLock,
    cargoLockRoot.index,
    cargoLockRoot.index + cargoLockRoot[0].length,
    version,
    'Cargo.lock root package',
  );
  const drift = [];
  if (lock.version !== version || lock.packages[''].version !== version) drift.push(files[1]);
  if (config.version !== version) drift.push(files[2]);
  if (cargo.version !== version) drift.push(files[3]);
  if (cargoLockResult.version !== version) drift.push(files[4]);
  if (check && drift.length)
    throw new Error(
      `Version mismatch with package.json ${version}: ${drift.join(', ')}. Run node scripts/sync-version.mjs.`,
    );
  if (!check && drift.length) {
    lock.version = version;
    lock.packages[''].version = version;
    config.version = version;
    const replacements = [
      contents[0],
      JSON.stringify(lock, null, 2) + '\n',
      JSON.stringify(config, null, 2) + '\n',
      cargo.text,
      cargoLockResult.text,
    ];
    // Parse every target before writing; never modify dependencies' versions.
    for (let i = 1; i < files.length; i++) {
      if (drift.includes(files[i])) await writeFile(resolve(root, files[i]), replacements[i]);
    }
  }
  return { version, changed: drift };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--check') || args.length > 1)
      throw new Error('Usage: node scripts/sync-version.mjs [--check]');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const result = await syncVersions(root, { check: args.includes('--check') });
    console.log(
      `Version ${result.version}: ${args.includes('--check') ? 'consistent' : result.changed.length ? `updated ${result.changed.join(', ')}` : 'already consistent'}.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
