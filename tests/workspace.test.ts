import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace } from '../src/state/workspace';
import type { Client, SessionInfo, TransferProgress } from '../src/bridge';
import type { FileEntry, Profile } from '../src/model';
const profile: Profile = {
  id: 'server-a',
  name: 'Server A',
  host: 'a.test',
  port: 21,
  username: 'test',
  protocol: 'ftps',
  authMethod: 'password',
  timeoutSeconds: 30,
};
const info: SessionInfo = { ...profile, cwd: '/remote' };
const file = (name: string): FileEntry => ({
  name,
  path: `/local/${name}`,
  size: 1024,
  isDirectory: false,
  modified: null,
});
const deferred = <T = void>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(connected = true) {
  let session: SessionInfo | null = connected ? info : null;
  let progress: (e: TransferProgress) => void = () => {};
  const client: Client = {
    available: true,
    beginConnectionAttempt: vi.fn(async () => crypto.randomUUID()),
    cancelConnectionAttempt: vi.fn(async () => {
      session = null;
    }),
    endConnectionAttempt: vi.fn(async () => {}),
    getSession: vi.fn(async () => session),
    inspectHost: vi.fn(async (p) => ({
      host: p.host,
      port: p.port,
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:test',
      status: 'trusted',
    })),
    trustHost: vi.fn(async (h) => ({ ...h, status: 'trusted' })),
    pickPath: vi.fn(async () => null),
    listLocal: vi.fn(async (path = '/local') => ({
      path,
      entries: [file('a.txt'), file('b.txt')],
    })),
    listRemote: vi.fn(async (path) => ({ path, entries: [] })),
    connect: vi.fn(async (p) => {
      session = { ...p, cwd: '/remote' };
      return { cwd: '/remote' };
    }),
    disconnect: vi.fn(async () => {
      session = null;
    }),
    transfer: vi.fn(async () => {}),
    cancel: vi.fn(async () => {
      session = null;
      return true;
    }),
    onProgress: vi.fn(async (fn) => {
      progress = fn;
      return () => {};
    }),
  };
  return {
    client,
    progress: (e: TransferProgress) => progress(e),
    setSession: (value: SessionInfo | null) => {
      session = value;
    },
  };
}
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k) || null,
    setItem: (k: string, v: string) => values.set(k, v),
  });
});
describe('workspace lifecycle', () => {
  it('discards remote responses from an earlier session', async () => {
    const { client } = fixture();
    const store = createWorkspace(client, []);
    await store.start();
    const old = deferred<{ path: string; entries: FileEntry[] }>();
    vi.mocked(client.listRemote).mockReturnValueOnce(old.promise);
    const pending = store.browse('remote', '/old');
    await store.disconnect();
    await store.connect({ ...profile, host: 'b.test' }, 'secret');
    old.resolve({ path: '/old', entries: [{ ...file('old.txt'), path: '/old/old.txt' }] });
    await pending;
    expect(store.getSnapshot().session?.host).toBe('b.test');
    expect(store.getSnapshot().remote.path).toBe('/remote');
    expect(store.getSnapshot().remote.entries).toEqual([]);
  });
  it('keeps a local startup listing valid while connecting', async () => {
    const { client } = fixture(false);
    const local = deferred<{ path: string; entries: FileEntry[] }>();
    vi.mocked(client.listLocal).mockReturnValueOnce(local.promise);
    const store = createWorkspace(client, []);
    const starting = store.start();
    await settle();
    await store.connect(profile, 'secret');
    local.resolve({ path: '/local', entries: [file('a.txt')] });
    await starting;
    expect(store.getSnapshot().local.busy).toBe(false);
    expect(store.getSnapshot().local.path).toBe('/local');
  });
  it('does not let a completed upload reverse pending navigation', async () => {
    const { client } = fixture();
    const store = createWorkspace(client, []);
    await store.start();
    const transfer = deferred();
    vi.mocked(client.transfer).mockReturnValueOnce(transfer.promise);
    store.select('local', ['/local/a.txt']);
    store.enqueue('local');
    const listing = deferred<{ path: string; entries: FileEntry[] }>();
    vi.mocked(client.listRemote).mockReturnValueOnce(listing.promise);
    const navigation = store.browse('remote', '/next');
    transfer.resolve();
    await settle();
    expect(vi.mocked(client.listRemote).mock.calls.map((args) => args[0])).toEqual([
      '/remote',
      '/next',
    ]);
    listing.resolve({ path: '/next', entries: [] });
    await navigation;
    expect(store.getSnapshot().remote.path).toBe('/next');
  });
  it('blocks downloads while their destination listing is pending or failed', async () => {
    const { client } = fixture();
    vi.mocked(client.listRemote).mockResolvedValue({
      path: '/remote',
      entries: [{ ...file('remote.txt'), path: '/remote/remote.txt' }],
    });
    const store = createWorkspace(client, []);
    await store.start();
    store.select('remote', ['/remote/remote.txt']);
    const local = deferred<{ path: string; entries: FileEntry[] }>();
    vi.mocked(client.listLocal).mockReturnValueOnce(local.promise);
    const navigation = store.browse('local', '/missing');
    store.enqueue('remote');
    expect(store.getSnapshot().queue).toEqual([]);
    local.reject(new Error('Not found'));
    await navigation;
    store.enqueue('remote');
    expect(store.getSnapshot().queue).toEqual([]);
  });
});
describe('serial transfer execution', () => {
  it('does not complete at 100% until the server confirms completion', async () => {
    const { client, progress } = fixture();
    const store = createWorkspace(client, []);
    await store.start();
    const transfer = deferred();
    vi.mocked(client.transfer).mockReturnValueOnce(transfer.promise);
    store.select('local', ['/local/a.txt']);
    store.enqueue('local');
    const item = store.getSnapshot().queue[0];
    progress({ id: item.id, bytes: 1024, total: 1024 });
    expect(store.getSnapshot().queue[0]).toMatchObject({ bytes: 1024, status: 'running' });
    transfer.resolve();
    await settle();
    expect(store.getSnapshot().queue[0].status).toBe('completed');
  });
  it('pauses between jobs, cancels waiting work and ignores duplicate enqueue', async () => {
    const { client } = fixture();
    const store = createWorkspace(client, []);
    await store.start();
    const transfer = deferred();
    vi.mocked(client.transfer).mockReturnValueOnce(transfer.promise);
    store.select('local', ['/local/a.txt', '/local/b.txt']);
    store.enqueue('local');
    store.pause(true);
    store.select('local', ['/local/a.txt']);
    store.enqueue('local');
    expect(store.getSnapshot().queue).toHaveLength(2);
    transfer.resolve();
    await settle();
    expect(client.transfer).toHaveBeenCalledTimes(1);
    const second = store.getSnapshot().queue[1];
    await store.cancel(second.id);
    store.pause(false);
    expect(client.transfer).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().queue[1].status).toBe('cancelled');
  });
  it('active cancellation clears the lost session and cancels remaining jobs', async () => {
    const { client } = fixture();
    const store = createWorkspace(client, []);
    await store.start();
    const transfer = deferred();
    vi.mocked(client.transfer).mockReturnValueOnce(transfer.promise);
    store.select('local', ['/local/a.txt', '/local/b.txt']);
    store.enqueue('local');
    await store.cancel(store.getSnapshot().queue[0].id);
    transfer.reject(new Error('Cancelled; connection closed'));
    await settle();
    expect(store.getSnapshot().phase).toBe('disconnected');
    expect(store.getSnapshot().queue.map((t) => t.status)).toEqual(['cancelled', 'cancelled']);
    expect(client.transfer).toHaveBeenCalledTimes(1);
  });
  it('keeps a healthy session usable after a conflict and continues the queue', async () => {
    const { client } = fixture();
    const store = createWorkspace(client, []);
    await store.start();
    vi.mocked(client.transfer).mockRejectedValueOnce(new Error('Already exists'));
    store.select('local', ['/local/a.txt', '/local/b.txt']);
    store.enqueue('local');
    await settle();
    expect(store.getSnapshot().queue.map((t) => t.status)).toEqual(['failed', 'completed']);
    expect(store.getSnapshot().phase).toBe('connected');
  });
  it('never persists supplied credentials in profile metadata', async () => {
    const { client } = fixture(false);
    const store = createWorkspace(client, []);
    await store.start();
    await store.connect({ ...profile, password: 'discard-this' } as Profile, 'session-secret');
    const stored = localStorage.getItem('better-ftp.profiles')!;
    expect(stored).toContain(profile.host);
    expect(JSON.parse(stored)[0]).not.toHaveProperty('password');
    expect(stored).not.toContain('discard-this');
    expect(stored).not.toContain('session-secret');
  });
});

describe('review regressions', () => {
  it.each(['false', 'reject'] as const)(
    'does not resurrect completed work after a late cancellation %s',
    async (outcome) => {
      const { client } = fixture();
      const store = createWorkspace(client, []);
      await store.start();
      const transfer = deferred();
      const cancellation = deferred<boolean>();
      vi.mocked(client.transfer).mockReturnValueOnce(transfer.promise);
      vi.mocked(client.cancel).mockReturnValueOnce(cancellation.promise);
      store.select('local', ['/local/a.txt']);
      store.enqueue('local');
      const cancelling = store.cancel(store.getSnapshot().queue[0].id);
      transfer.resolve();
      await settle();
      if (outcome === 'false') cancellation.resolve(false);
      else cancellation.reject(new Error('Too late'));
      await cancelling;
      expect(store.getSnapshot().queue[0].status).toBe('completed');
      expect(store.busy()).toBe(false);
    },
  );
  it('preserves measured completion bytes when source size changed', async () => {
    const { client, progress } = fixture();
    const store = createWorkspace(client, []);
    await store.start();
    const transfer = deferred();
    vi.mocked(client.transfer).mockReturnValueOnce(transfer.promise);
    store.select('local', ['/local/a.txt']);
    store.enqueue('local');
    const id = store.getSnapshot().queue[0].id;
    progress({ id, bytes: 2048, total: 2048 });
    transfer.resolve();
    await settle();
    expect(store.getSnapshot().queue[0]).toMatchObject({ status: 'completed', bytes: 2048 });
  });
  it('uses the canonical server directory after relative navigation', async () => {
    const { client } = fixture();
    const store = createWorkspace(client, []);
    await store.start();
    vi.mocked(client.listRemote).mockResolvedValueOnce({ path: '/remote/assets', entries: [] });
    await store.browse('remote', 'assets');
    store.select('local', ['/local/a.txt']);
    store.enqueue('local');
    expect(vi.mocked(client.transfer).mock.calls[0][0].destination).toBe('/remote/assets/a.txt');
    await settle();
  });
  it('ignores recovery responses belonging to an old session', async () => {
    const { client } = fixture();
    const store = createWorkspace(client, []);
    await store.start();
    const recovery = deferred<SessionInfo | null>();
    vi.mocked(client.getSession).mockReturnValueOnce(recovery.promise);
    vi.mocked(client.transfer).mockRejectedValueOnce(new Error('Connection lost'));
    store.select('local', ['/local/a.txt']);
    store.enqueue('local');
    await settle();
    await store.disconnect();
    await store.connect({ ...profile, host: 'b.test' }, 'secret');
    recovery.resolve(null);
    await settle();
    expect(store.getSnapshot().session?.host).toBe('b.test');
    expect(store.getSnapshot().phase).toBe('connected');
  });
  it('cancel-all waits for active termination before allowing close', async () => {
    const { client } = fixture();
    const store = createWorkspace(client, []);
    await store.start();
    const transfer = deferred();
    vi.mocked(client.transfer).mockReturnValueOnce(transfer.promise);
    store.select('local', ['/local/a.txt', '/local/b.txt']);
    store.enqueue('local');
    let closed = false;
    const closing = store.cancelAll().then(() => {
      closed = true;
    });
    await settle();
    expect(closed).toBe(false);
    transfer.reject(new Error('Cancelled'));
    await closing;
    expect(store.busy()).toBe(false);
    expect(store.getSnapshot().queue.map((t) => t.status)).toEqual(['cancelled', 'cancelled']);
  });
});

it('updates active throughput and reports zero after stalled progress', async () => {
  const { client, progress } = fixture();
  const store = createWorkspace(client, []);
  await store.start();
  vi.useFakeTimers();
  try {
    const transfer = deferred();
    vi.mocked(client.transfer).mockReturnValueOnce(transfer.promise);
    store.select('local', ['/local/a.txt']);
    store.enqueue('local');
    const id = store.getSnapshot().queue[0].id;
    progress({ id, bytes: 0, total: 1024 });
    await vi.advanceTimersByTimeAsync(500);
    progress({ id, bytes: 1024, total: 1024 });
    expect(store.getSnapshot().queue[0].speed).toBe(2048);
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getSnapshot().queue[0]).toMatchObject({ speed: 0, status: 'running' });
    transfer.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getSnapshot().queue[0].status).toBe('completed');
  } finally {
    store.dispose();
    vi.useRealTimers();
  }
});

describe('connection attempt cancellation', () => {
  it('does not restore an aborted connection when an old native reply arrives', async () => {
    const { client } = fixture(false);
    const old = deferred<{ cwd: string }>();
    vi.mocked(client.connect).mockReturnValueOnce(old.promise);
    const store = createWorkspace(client, []);
    await store.start();
    const connecting = store.connect(profile, 'secret');
    await settle();
    expect(store.getSnapshot().phase).toBe('connecting');
    await store.abortConnection();
    expect(store.getSnapshot().phase).toBe('disconnected');
    const other = { ...profile, id: 'server-b', host: 'b.test' };
    await store.connect(other, 'new-secret');
    old.resolve({ cwd: '/stale' });
    expect(await connecting).toBe(false);
    expect(store.getSnapshot().session?.host).toBe('b.test');
    expect(store.getSnapshot().remote.path).toBe('/remote');
    expect(client.cancelConnectionAttempt).toHaveBeenCalledOnce();
  });
  it('can abort while native attempt registration is still pending', async () => {
    const { client } = fixture(false);
    const registration = deferred<string>();
    vi.mocked(client.beginConnectionAttempt).mockReturnValueOnce(registration.promise);
    const store = createWorkspace(client, []);
    await store.start();
    const starting = store.beginConnection().catch(() => {});
    const aborting = store.abortConnection();
    registration.resolve('pending-attempt');
    await Promise.all([starting, aborting]);
    expect(client.cancelConnectionAttempt).toHaveBeenCalledWith('pending-attempt');
    expect(store.getSnapshot().phase).toBe('disconnected');
    expect(client.connect).not.toHaveBeenCalled();
  });
  it('preserves the last successful settings through disconnect without retaining secrets', async () => {
    const { client } = fixture(false);
    const store = createWorkspace(client, []);
    await store.start();
    const configured = {
      ...profile,
      privateKeyPath: '/key',
      localPath: '/local',
      remotePath: '/remote',
      timeoutSeconds: 12,
    };
    await store.connect(configured, 'never-retained');
    await store.disconnect();
    expect(store.getSnapshot().lastConnection).toMatchObject({
      host: profile.host,
      timeoutSeconds: 12,
      localPath: '/local',
      remotePath: '/remote',
    });
    expect(JSON.stringify(store.getSnapshot())).not.toContain('never-retained');
  });
  it('does not abort or disconnect a connected session when no attempt is active', async () => {
    const { client } = fixture(false);
    const store = createWorkspace(client, []);
    await store.start();
    await store.connect(profile, 'secret');
    await store.abortConnection();
    expect(store.getSnapshot().phase).toBe('connected');
    expect(client.cancelConnectionAttempt).not.toHaveBeenCalled();
  });
});

it('returns to disconnected if native registration fails during abort', async () => {
  const { client } = fixture(false);
  const registration = deferred<string>();
  vi.mocked(client.beginConnectionAttempt).mockReturnValueOnce(registration.promise);
  const store = createWorkspace(client, []);
  await store.start();
  const starting = store.beginConnection().catch(() => {});
  const aborting = store.abortConnection();
  registration.reject(new Error('Registration failed.'));
  await Promise.all([starting, aborting]);
  expect(store.getSnapshot().phase).toBe('disconnected');
  await store.connect(profile, 'retry');
  expect(store.getSnapshot().phase).toBe('connected');
});

it('ending an aborted UI attempt cannot reset a newer connection attempt', async () => {
  const { client } = fixture(false);
  const store = createWorkspace(client, []);
  await store.start();
  const old = deferred<{ cwd: string }>();
  vi.mocked(client.connect).mockReturnValueOnce(old.promise);
  const firstId = await store.beginConnection();
  const first = store.connect(profile, 'old', firstId);
  await settle();
  await store.abortConnection();
  const nextId = await store.beginConnection();
  old.resolve({ cwd: '/old' });
  await first;
  await store.endConnection(firstId);
  expect(store.getSnapshot().phase).toBe('connecting');
  expect(await store.connect({ ...profile, host: 'next.test' }, 'new', nextId)).toBe(true);
  await store.endConnection(nextId);
  expect(store.getSnapshot().session?.host).toBe('next.test');
});
