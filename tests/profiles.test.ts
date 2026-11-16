import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProfiles, profileMetadata, defaultPort, type Profile } from '../src/model';
let serialized = '[]';
beforeEach(() => {
  serialized = '[]';
  vi.stubGlobal('localStorage', { getItem: () => serialized });
});
const base = { id: 'one', name: 'Server', host: 'example.test', port: 21, username: 'user' };
describe('connection profile migration and persistence', () => {
  it('migrates legacy secure booleans without changing FTP semantics', () => {
    serialized = JSON.stringify([
      { ...base, secure: false },
      { ...base, id: 'two', secure: true, password: 'never-copy' },
    ]);
    expect(loadProfiles()).toEqual([
      { ...base, protocol: 'ftp', authMethod: 'password', timeoutSeconds: 30 },
      { ...base, id: 'two', protocol: 'ftps', authMethod: 'password', timeoutSeconds: 30 },
    ]);
    expect(JSON.stringify(loadProfiles())).not.toContain('never-copy');
  });
  it('preserves SFTP key authentication and starting-directory settings', () => {
    const profile: Profile = {
      ...base,
      port: 2222,
      protocol: 'sftp',
      authMethod: 'privateKey',
      privateKeyPath: '/keys/id_ed25519',
      localPath: '/work',
      remotePath: 'web',
      timeoutSeconds: 60,
    };
    serialized = JSON.stringify([profile]);
    expect(loadProfiles()[0]).toEqual(profile);
  });
  it('whitelists settings and never stores authentication secrets', () => {
    const value = {
      ...base,
      protocol: 'sftp',
      authMethod: 'privateKey',
      timeoutSeconds: 30,
      privateKeyPath: '/keys/key',
      password: 'secret',
      passphrase: 'secret2',
      privateKeyContents: 'secret3',
    } as Profile;
    const stored = profileMetadata(value);
    expect(stored).not.toHaveProperty('password');
    expect(stored).not.toHaveProperty('passphrase');
    expect(stored).not.toHaveProperty('privateKeyContents');
    expect(stored.authMethod).toBe('privateKey');
  });
  it('rejects invalid protocols/ports and normalizes unsupported auth and timeout metadata', () => {
    serialized = JSON.stringify([
      { ...base, protocol: 'ssh-shell' },
      { ...base, protocol: 'sftp', port: 0 },
      {
        ...base,
        protocol: 'ftps',
        authMethod: 'privateKey',
        privateKeyPath: '/unused',
        timeoutSeconds: 0,
      },
    ]);
    expect(loadProfiles()).toEqual([
      { ...base, protocol: 'ftps', authMethod: 'password', timeoutSeconds: 30 },
    ]);
  });
  it('uses port22 for SSH and port21 for FTP/explicit FTPS', () => {
    expect(defaultPort('sftp')).toBe(22);
    expect(defaultPort('ftp')).toBe(21);
    expect(defaultPort('ftps')).toBe(21);
  });
});
