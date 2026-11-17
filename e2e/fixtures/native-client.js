// Injected by Playwright request interception. Never imported by application source.
const file = (parent, name, isDirectory = false, size = 4096) => ({
  name,
  path: `${parent}/${name}`,
  isDirectory,
  size: isDirectory ? 0 : size,
  modified: '2026-10-23T09:15:00Z',
});
const local = {
  '/workspace': [
    file('/workspace', 'assets', true),
    file('/workspace', 'build', true),
    file('/workspace', 'src', true),
    file('/workspace', 'app.tsx'),
    file('/workspace', 'package.json', false, 840),
    file('/workspace', 'README.md', false, 2400),
    file('/workspace', '.gitignore', false, 96),
  ],
  '/workspace/assets': [file('/workspace/assets', 'logo.svg', false, 1240)],
  '/workspace/build': [],
  '/workspace/src': [],
  '/': [file('', 'workspace', true)],
};
const remote = {
  '/srv/www': [
    file('/srv/www', 'assets', true),
    file('/srv/www', 'logs', true),
    file('/srv/www', 'index.html', false, 6200),
    file('/srv/www', 'robots.txt', false, 92),
  ],
  '/srv/www/assets': [file('/srv/www/assets', 'main.css', false, 23400)],
  '/srv/www/logs': [],
  '/srv': [file('/srv', 'www', true)],
  '/': [file('', 'srv', true)],
};
let session = null;
let active = null;
const handlers = new Set();
let cancelled = false;
const attempts = new Map();
export const client = {
  available: true,
  async beginConnectionAttempt() {
    const id = crypto.randomUUID();
    attempts.set(id, false);
    return id;
  },
  async cancelConnectionAttempt(id) {
    attempts.set(id, true);
    session = null;
  },
  async endConnectionAttempt(id) {
    attempts.delete(id);
  },
  async inspectHost(profile, attemptId) {
    if (profile.host === 'slow.example.test') {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (attempts.get(attemptId) !== false) throw new Error('Connection attempt aborted.');
    }
    return {
      host: profile.host,
      port: profile.port,
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:verified-test-host-key',
      status:
        profile.host === 'unknown.example.test'
          ? 'unknown'
          : profile.host === 'changed.example.test'
            ? 'changed'
            : 'trusted',
    };
  },
  async trustHost(info) {
    return { ...info, status: 'trusted' };
  },
  async pickPath(kind) {
    return kind === 'key' ? '/keys/id_ed25519' : '/workspace';
  },
  async getSession() {
    return session;
  },
  async listLocal(path = '/workspace') {
    if (!local[path]) throw new Error('Local directory does not exist.');
    return { path, entries: [...local[path]] };
  },
  async listRemote(path) {
    if (!session) throw new Error('Not connected.');
    if (!path.startsWith('/')) path = session.cwd + '/' + path;
    if (!remote[path]) throw new Error('Remote directory does not exist.');
    session.cwd = path;
    return { path, entries: [...remote[path]] };
  },
  async connect(profile, password, attemptId) {
    if (password === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (attempts.get(attemptId) !== false) throw new Error('Connection attempt aborted.');
    }
    if (password === 'bad') throw new Error('Login failed.');
    session = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      protocol: profile.protocol,
      authMethod: profile.authMethod,
      cwd: '/srv/www',
    };
    session.cwd = profile.remotePath || '/srv/www';
    return { cwd: session.cwd };
  },
  async disconnect() {
    session = null;
  },
  async transfer(item) {
    if (!session) throw new Error('Not connected.');
    active = item.id;
    cancelled = false;
    const tree = item.direction === 'upload' ? remote : local;
    const i = item.destination.lastIndexOf('/');
    const parent = item.destination.slice(0, i) || '/';
    if (tree[parent].some((e) => e.name === item.name)) {
      active = null;
      throw new Error('A destination entry already exists.');
    }
    for (let step = 0; step <= 4; step++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (cancelled) {
        active = null;
        session = null;
        throw new Error('Transfer cancelled. Connection closed.');
      }
      handlers.forEach((fn) =>
        fn({ id: item.id, bytes: Math.floor((item.size * step) / 4), total: item.size }),
      );
    }
    tree[parent].push(file(parent, item.name, false, item.size));
    active = null;
  },
  async cancel(id) {
    if (active !== id) return false;
    cancelled = true;
    return true;
  },
  async onProgress(handler) {
    handlers.add(handler);
    return () => handlers.delete(handler);
  },
};
