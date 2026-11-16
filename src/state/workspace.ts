import { TransferMeter } from '../lib/transfer-meter';
import type { Client, SessionInfo } from '../bridge';
import {
  joinPath,
  loadProfiles,
  profileMetadata,
  type FileEntry,
  type Profile,
  type Transfer,
} from '../model';
export type Side = 'local' | 'remote';
export interface PaneState {
  path: string;
  entries: FileEntry[];
  selected: string[];
  busy: boolean;
  error: string;
  history: string[];
  historyIndex: number;
  revision: number;
}
export interface Session extends SessionInfo {
  id: string;
  name: string;
}
export interface LogEntry {
  id: number;
  time: number;
  level: 'info' | 'error';
  message: string;
}
export interface WorkspaceState {
  phase: 'starting' | 'disconnected' | 'connecting' | 'connected' | 'disconnecting';
  session: Session | null;
  profiles: Profile[];
  local: PaneState;
  remote: PaneState;
  queue: Transfer[];
  paused: boolean;
  error: string;
  logs: LogEntry[];
}
const pane = (): PaneState => ({
  path: '',
  entries: [],
  selected: [],
  busy: false,
  error: '',
  history: [],
  historyIndex: -1,
  revision: 0,
});
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function createWorkspace(client: Client, initialProfiles: Profile[] = loadProfiles()) {
  let state: WorkspaceState = {
    phase: 'starting',
    session: null,
    profiles: initialProfiles,
    local: pane(),
    remote: pane(),
    queue: [],
    paused: false,
    error: '',
    logs: [],
  };
  const subscribers = new Set<() => void>();
  let epoch = 0;
  let activeId: string | null = null;
  let meter: TransferMeter | null = null;
  let speedTimer: ReturnType<typeof setInterval> | undefined;
  let started: Promise<void> | undefined;
  let sequence = 0;
  let stopProgress: (() => void) | undefined;
  const update = (patch: Partial<WorkspaceState>) => {
    state = { ...state, ...patch };
    subscribers.forEach((fn) => fn());
  };
  const updatePane = (side: Side, patch: Partial<PaneState>) =>
    update({ [side]: { ...state[side], ...patch } });
  const log = (text: string, level: LogEntry['level'] = 'info') =>
    update({
      logs: [...state.logs, { id: ++sequence, time: Date.now(), level, message: text }].slice(-300),
    });
  const updateTransfer = (id: string, patch: Partial<Transfer>) =>
    update({ queue: state.queue.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  const busy = () =>
    state.queue.some((t) => ['queued', 'running', 'cancelling'].includes(t.status));

  async function browse(side: Side, path?: string, index?: number) {
    if (side === 'remote' && !state.session) return;
    const generation = epoch;
    const revision = state[side].revision + 1;
    updatePane(side, {
      revision,
      path: path ?? state[side].path,
      busy: true,
      error: '',
      entries: [],
      selected: [],
    });
    try {
      const result =
        side === 'local' ? await client.listLocal(path) : await client.listRemote(path || '/');
      if ((side === 'remote' && epoch !== generation) || state[side].revision !== revision) return;
      const old = state[side];
      const history =
        index === undefined
          ? old.history[old.historyIndex] === result.path
            ? old.history
            : [...old.history.slice(0, old.historyIndex + 1), result.path]
          : old.history;
      updatePane(side, {
        ...result,
        busy: false,
        error: '',
        history,
        historyIndex: index ?? history.length - 1,
      });
    } catch (error) {
      if ((side === 'remote' && epoch !== generation) || state[side].revision !== revision) return;
      updatePane(side, { busy: false, error: message(error) });
      if (client.available) log(message(error), 'error');
      if (side === 'remote') await recoverSession().catch(() => {});
    }
  }
  async function recoverSession() {
    const generation = epoch;
    const sessionId = state.session?.id;
    const info = await client.getSession();
    if (generation !== epoch || sessionId !== state.session?.id) return info;
    if (!info && state.session) {
      epoch++;
      update({
        session: null,
        phase: 'disconnected',
        remote: { ...pane(), revision: state.remote.revision + 1 },
        queue: state.queue.map((t) =>
          t.status === 'queued' ? { ...t, status: 'cancelled', error: 'Connection closed.' } : t,
        ),
      });
      log('Connection closed. Reconnect to continue.', 'error');
    }
    return info;
  }
  async function runQueue() {
    if (activeId || state.paused || state.phase !== 'connected' || !state.session) return;
    const sessionId = state.session.id;
    const next = state.queue.find((t) => t.status === 'queued' && t.sessionId === sessionId);
    if (!next) return;
    activeId = next.id;
    meter = new TransferMeter();
    speedTimer = setInterval(() => {
      if (activeId === next.id && meter) updateTransfer(next.id, { speed: meter.rate() });
    }, 250);
    const destinationSide: Side = next.direction === 'upload' ? 'remote' : 'local';
    const view = { path: state[destinationSide].path, revision: state[destinationSide].revision };
    updateTransfer(next.id, { status: 'running', bytes: 0, measured: false, speed: null });
    log(`${next.direction === 'upload' ? 'Uploading' : 'Downloading'} ${next.name}`);
    try {
      await client.transfer(next);
      if (state.session?.id !== sessionId) return;
      const latest = state.queue.find((t) => t.id === next.id);
      const bytes = latest?.measured ? latest.bytes : next.size;
      updateTransfer(next.id, { status: 'completed', bytes, speed: meter?.average(bytes) ?? null });
      log(`Transferred ${next.name}`);
      // A completed transfer must never override a newer navigation request.
      const current = state[destinationSide];
      if (current.path === view.path && current.revision === view.revision && !current.busy)
        void browse(destinationSide, current.path);
    } catch (error) {
      const cancelled = state.queue.find((t) => t.id === next.id)?.status === 'cancelling';
      updateTransfer(next.id, {
        status: cancelled ? 'cancelled' : 'failed',
        error: message(error),
      });
      log(message(error), cancelled ? 'info' : 'error');
      try {
        await recoverSession();
      } catch {
        update({
          paused: true,
          error: 'Cannot verify the connection. Disconnect and reconnect before continuing.',
        });
      }
    } finally {
      clearInterval(speedTimer);
      speedTimer = undefined;
      meter = null;
      activeId = null;
      update({});
      void runQueue();
    }
  }
  async function initialize() {
    try {
      stopProgress = await client.onProgress((event) => {
        if (event.id !== activeId) return;
        meter?.record(event.bytes);
        updateTransfer(event.id, {
          bytes: event.bytes,
          total: event.total,
          measured: true,
          speed: meter?.rate() ?? null,
        });
      });
      const info = await client.getSession();
      if (info) {
        const saved = state.profiles.find(
          (p) =>
            p.host === info.host &&
            p.port === info.port &&
            p.username === info.username &&
            p.protocol === info.protocol,
        );
        update({
          session: { ...info, id: crypto.randomUUID(), name: saved?.name || info.host },
          phase: 'connected',
        });
        log(`Restored ${info.host}:${info.port}`);
      } else update({ phase: 'disconnected' });
      await Promise.all([browse('local'), info ? browse('remote', info.cwd) : Promise.resolve()]);
    } catch (error) {
      update({ phase: 'disconnected', error: message(error) });
      await browse('local');
    }
  }
  function saveProfile(profile: Profile) {
    const safe = profileMetadata(profile);
    const profiles = [...state.profiles.filter((p) => p.id !== safe.id), safe].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    // Whitelist fields at the persistence boundary, even if callers pass extra properties.
    try {
      localStorage.setItem('better-ftp.profiles', JSON.stringify(profiles.map(profileMetadata)));
      update({ profiles });
    } catch {
      update({ error: 'Could not save connection profiles.' });
      return false;
    }
    return true;
  }
  async function cancel(id: string) {
    const item = state.queue.find((t) => t.id === id);
    if (item?.status === 'queued') {
      updateTransfer(id, { status: 'cancelled' });
      return;
    }
    if (item?.status !== 'running') return;
    updateTransfer(id, { status: 'cancelling' });
    try {
      if (
        !(await client.cancel(id)) &&
        activeId === id &&
        state.queue.find((t) => t.id === id)?.status === 'cancelling'
      )
        updateTransfer(id, { status: 'running' });
    } catch (error) {
      if (activeId === id && state.queue.find((t) => t.id === id)?.status === 'cancelling') {
        updateTransfer(id, { status: 'running' });
        update({ error: message(error) });
      }
    }
  }
  return {
    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    getSnapshot: () => state,
    start: () => (started ??= initialize()),
    dispose: () => {
      epoch++;
      stopProgress?.();
      clearInterval(speedTimer);
      subscribers.clear();
    },
    available: client.available,
    pickPath: client.pickPath,
    busy,
    browse,
    refresh: (side: Side) =>
      browse(
        side,
        state[side].path || undefined,
        state[side].historyIndex >= 0 ? state[side].historyIndex : undefined,
      ),
    history: (side: Side, offset: number) => {
      const p = state[side],
        index = p.historyIndex + offset;
      if (!p.busy && index >= 0 && index < p.history.length)
        void browse(side, p.history[index], index);
    },
    select: (side: Side, selected: string[]) => {
      if (!state[side].busy && !state[side].error)
        updatePane(side, {
          selected: selected.filter((path) => state[side].entries.some((e) => e.path === path)),
        });
    },
    saveProfile,
    removeProfile: (id: string) => {
      const profiles = state.profiles.filter((p) => p.id !== id);
      try {
        localStorage.setItem('better-ftp.profiles', JSON.stringify(profiles.map(profileMetadata)));
        update({ profiles });
      } catch {
        update({ error: 'Could not remove the connection profile.' });
      }
    },
    clearError: () => update({ error: '' }),
    clearLogs: () => update({ logs: [] }),
    async connect(profile: Profile, password: string) {
      if (!client.available)
        throw new Error('Server connections are available in the desktop application.');
      if (state.phase !== 'disconnected') throw new Error('Disconnect the current session first.');
      epoch++;
      update({ phase: 'connecting', error: '' });
      try {
        const result = await client.connect(profile, password);
        saveProfile(profile);
        update({
          phase: 'connected',
          session: { ...profileMetadata(profile), cwd: result.cwd, id: crypto.randomUUID() },
          queue: [],
          paused: false,
        });
        log(`Connected to ${profile.host}:${profile.port} (${profile.protocol.toUpperCase()})`);
        await Promise.all([
          browse('remote', result.cwd),
          profile.localPath ? browse('local', profile.localPath) : Promise.resolve(),
        ]);
      } catch (error) {
        update({ phase: 'disconnected' });
        log(message(error), 'error');
        throw error;
      }
    },
    async disconnect() {
      if (busy()) throw new Error('Cancel or finish queued transfers before disconnecting.');
      epoch++;
      update({
        phase: 'disconnecting',
        remote: { ...pane(), revision: state.remote.revision + 1 },
      });
      try {
        await client.disconnect();
        update({ phase: 'disconnected', session: null });
        log('Disconnected.');
      } catch (error) {
        update({ phase: 'connected', error: message(error) });
        throw error;
      }
    },
    enqueue(side: Side) {
      const destinationSide = side === 'local' ? 'remote' : 'local';
      const source = state[side],
        destination = state[destinationSide];
      if (
        state.phase !== 'connected' ||
        !state.session ||
        source.busy ||
        destination.busy ||
        source.error ||
        destination.error ||
        !source.path ||
        !destination.path
      )
        return;
      const entries = source.entries.filter(
        (e) => source.selected.includes(e.path) && !e.isDirectory,
      );
      const items: Transfer[] = entries.map((e) => ({
        id: crypto.randomUUID(),
        sessionId: state.session!.id,
        name: e.name,
        direction: side === 'local' ? 'upload' : 'download',
        source: e.path,
        destination: joinPath(destination.path, e.name),
        size: e.size,
        bytes: 0,
        total: e.size,
        status: 'queued',
      }));
      // Ignore duplicate pending jobs for the same session and destination.
      update({
        queue: [
          ...state.queue,
          ...items.filter(
            (item) =>
              !state.queue.some(
                (t) =>
                  t.sessionId === item.sessionId &&
                  t.direction === item.direction &&
                  t.destination === item.destination &&
                  ['queued', 'running', 'cancelling'].includes(t.status),
              ),
          ),
        ],
      });
      updatePane(side, { selected: [] });
      void runQueue();
    },
    pause: (paused: boolean) => {
      update({ paused });
      if (!paused) void runQueue();
    },
    cancel,
    async cancelAll() {
      update({ paused: true });
      for (const item of state.queue.filter((t) => ['queued', 'running'].includes(t.status)))
        await cancel(item.id);
      if (activeId)
        await new Promise<void>((resolve) => {
          const listener = () => {
            if (!activeId) {
              subscribers.delete(listener);
              resolve();
            }
          };
          subscribers.add(listener);
          listener();
        });
      if (busy())
        throw new Error('Could not stop every transfer. Keep the window open and try again.');
    },
    retry(id: string) {
      const item = state.queue.find((t) => t.id === id);
      if (!item || item.status !== 'failed' || state.session?.id !== item.sessionId) return;
      updateTransfer(id, {
        status: 'queued',
        error: undefined,
        bytes: 0,
        speed: null,
        measured: false,
      });
      void runQueue();
    },
    clearFinished: () =>
      update({
        queue: state.queue.filter((t) => ['queued', 'running', 'cancelling'].includes(t.status)),
      }),
  };
}
export type Workspace = ReturnType<typeof createWorkspace>;
