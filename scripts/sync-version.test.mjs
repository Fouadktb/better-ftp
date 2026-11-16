import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncVersions, validateVersion } from './sync-version.mjs';

test('validates release and prerelease SemVer', () => {
  for (const value of ['0.1.0', '0.1.0-alpha.1', '0.2.0-beta.0', '1.2.3-rc.1+build.42'])
    assert.equal(validateVersion(value), value);
  for (const value of [
    'v0.1.0',
    '1.2',
    '01.2.3',
    '1.2.3-alpha.01',
    '1.2.3-',
    '1.2.3+',
    '1.2.3\n',
    ' 1.2.3',
    '',
    null,
  ])
    assert.throws(() => validateVersion(value));
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'better-ftp-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src-tauri'));
  const files = {
    'package.json': JSON.stringify({ name: 'better-ftp', version: '0.1.0-alpha.1' }),
    'package-lock.json': JSON.stringify({
      name: 'better-ftp',
      version: '0.0.1',
      packages: {
        '': { name: 'better-ftp', version: '0.0.1' },
        'node_modules/dependency': { version: '9.9.9' },
      },
    }),
    'src-tauri/tauri.conf.json': JSON.stringify({ version: '0.0.1', productName: 'Better FTP' }),
    'src-tauri/Cargo.toml':
      '[package]\nname = "better-ftp"\nversion = "0.0.1"\n\n[dependencies]\nother = { version = "8.8.8" }\n',
    'src-tauri/Cargo.lock':
      '# generated\nversion = 4\n\n[[package]]\nname = "other"\nversion = "8.8.8"\n\n[[package]]\nname = "better-ftp"\nversion = "0.0.1"\ndependencies = ["other"]\n',
  };
  for (const [file, content] of Object.entries(files)) await writeFile(join(root, file), content);
  return { root, files };
}

test('check detects drift without writes; sync changes only root versions and is idempotent', async (t) => {
  const { root, files } = await fixture(t);
  await assert.rejects(syncVersions(root, { check: true }), /Version mismatch/);
  for (const [file, content] of Object.entries(files))
    assert.equal(await readFile(join(root, file), 'utf8'), content);
  assert.equal((await syncVersions(root)).changed.length, 4);
  assert.deepEqual(await syncVersions(root, { check: true }), {
    version: '0.1.0-alpha.1',
    changed: [],
  });
  assert.deepEqual((await syncVersions(root)).changed, []);
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, '0.1.0-alpha.1');
  assert.equal(lock.packages[''].version, '0.1.0-alpha.1');
  assert.equal(lock.packages['node_modules/dependency'].version, '9.9.9');
  assert.match(
    await readFile(join(root, 'src-tauri/Cargo.toml'), 'utf8'),
    /other = \{ version = "8.8.8" \}/,
  );
  assert.match(
    await readFile(join(root, 'src-tauri/Cargo.lock'), 'utf8'),
    /name = "other"\nversion = "8.8.8"/,
  );
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), files['package.json']);
});

test('invalid source or missing lock entry fails before changing any target', async (t) => {
  const { root, files } = await fixture(t);
  await writeFile(join(root, 'src-tauri/Cargo.lock'), 'version = 4\n');
  await assert.rejects(syncVersions(root), /exactly one local root/);
  assert.equal(await readFile(join(root, 'package-lock.json'), 'utf8'), files['package-lock.json']);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'better-ftp', version: 'bad' }),
  );
  await assert.rejects(syncVersions(root), /valid SemVer/);
  assert.equal(
    await readFile(join(root, 'src-tauri/Cargo.toml'), 'utf8'),
    files['src-tauri/Cargo.toml'],
  );
});
