import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import type { FileEntry, Profile, Transfer, Protocol, AuthMethod } from './model';

export interface SessionInfo {
  host: string;
  port: number;
  username: string;
  protocol: Protocol;
  authMethod: AuthMethod;
  cwd: string;
}
export interface HostKeyInfo {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  status: 'unknown' | 'trusted' | 'changed';
}
export interface TransferProgress {
  id: string;
  bytes: number;
  total: number | null;
}
export interface Client {
  readonly available: boolean;
  getSession(): Promise<SessionInfo | null>;
  beginConnectionAttempt(): Promise<string>;
  cancelConnectionAttempt(id: string): Promise<void>;
  endConnectionAttempt(id: string): Promise<void>;
  inspectHost(profile: Profile, attemptId?: string): Promise<HostKeyInfo>;
  trustHost(info: HostKeyInfo, timeoutSeconds: number, attemptId?: string): Promise<HostKeyInfo>;
  pickPath(kind: 'key' | 'directory'): Promise<string | null>;
  listLocal(path?: string): Promise<{ path: string; entries: FileEntry[] }>;
  listRemote(path: string): Promise<{ path: string; entries: FileEntry[] }>;
  connect(profile: Profile, password: string, attemptId?: string): Promise<{ cwd: string }>;
  disconnect(): Promise<void>;
  transfer(item: Transfer): Promise<void>;
  cancel(id: string): Promise<boolean>;
  onProgress(handler: (event: TransferProgress) => void): Promise<() => void>;
}
const available = isTauri();
function desktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!available)
    return Promise.reject(
      new Error('Local files and server connections require the desktop application.'),
    );
  return invoke<T>(command, args);
}
export const client: Client = {
  available,
  getSession: () => (available ? desktop('get_session') : Promise.resolve(null)),
  beginConnectionAttempt: () => desktop('begin_connection_attempt'),
  cancelConnectionAttempt: (id) => desktop('cancel_connection_attempt', { id }),
  endConnectionAttempt: (id) => desktop('end_connection_attempt', { id }),
  inspectHost: (profile, attemptId) =>
    desktop('inspect_ssh_host', {
      attemptId: attemptId ?? null,
      input: { host: profile.host, port: profile.port, timeoutSeconds: profile.timeoutSeconds },
    }),
  trustHost: (info, timeoutSeconds, attemptId) =>
    desktop('trust_ssh_host', {
      attemptId: attemptId ?? null,
      input: { host: info.host, port: info.port, fingerprint: info.fingerprint, timeoutSeconds },
    }),
  pickPath: async (kind) => {
    if (!available) throw new Error('File selection requires the desktop application.');
    const result = await open({
      directory: kind === 'directory',
      multiple: false,
      title: kind === 'key' ? 'Select SSH private key' : 'Select default local directory',
    });
    return typeof result === 'string' ? result : null;
  },
  listLocal: (path) => desktop('list_local', { path: path || null }),
  listRemote: (path) => desktop('list_remote', { path }),
  connect: (profile, password, attemptId) =>
    desktop('connect_remote', {
      attemptId: attemptId ?? null,
      input: {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        protocol: profile.protocol,
        authMethod: profile.authMethod,
        privateKeyPath: profile.privateKeyPath || null,
        timeoutSeconds: profile.timeoutSeconds,
        remotePath: profile.remotePath || null,
        password,
      },
    }),
  disconnect: () => desktop('disconnect_remote'),
  transfer: (item) =>
    desktop('transfer_file', {
      input: {
        id: item.id,
        direction: item.direction,
        source: item.source,
        destination: item.destination,
      },
    }),
  cancel: (id) => desktop('cancel_transfer', { id }),
  onProgress: (handler) =>
    available
      ? listen<TransferProgress>('transfer-progress', (event) => handler(event.payload))
      : Promise.resolve(() => {}),
};
