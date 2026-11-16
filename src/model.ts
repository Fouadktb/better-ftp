export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string | null;
}
export type Protocol = 'ftp' | 'ftps' | 'sftp';
export type AuthMethod = 'password' | 'privateKey' | 'agent';
export interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  protocol: Protocol;
  authMethod: AuthMethod;
  timeoutSeconds: number;
  privateKeyPath?: string;
  localPath?: string;
  remotePath?: string;
}
export const defaultPort = (protocol: Protocol) => (protocol === 'sftp' ? 22 : 21);
export function profileMetadata(profile: Profile): Profile {
  const {
    id,
    name,
    host,
    port,
    username,
    protocol,
    authMethod,
    timeoutSeconds,
    privateKeyPath,
    localPath,
    remotePath,
  } = profile;
  return {
    id,
    name,
    host,
    port,
    username,
    protocol,
    authMethod: protocol === 'sftp' ? authMethod : 'password',
    timeoutSeconds,
    privateKeyPath: protocol === 'sftp' && authMethod === 'privateKey' ? privateKeyPath : undefined,
    localPath: localPath || undefined,
    remotePath: remotePath || undefined,
  };
}
export interface Transfer {
  id: string;
  name: string;
  direction: 'upload' | 'download';
  source: string;
  destination: string;
  size: number;
  sessionId: string;
  bytes: number;
  measured?: boolean;
  speed?: number | null;
  total: number | null;
  status: 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  error?: string;
}
export function joinPath(parent: string, name: string) {
  const sep = parent.includes('\\') ? '\\' : '/';
  return parent.replace(/[\\/]+$/, '') + sep + name;
}
export function parentPath(path: string) {
  // Windows canonical paths may carry a verbatim prefix. Keep drive/share roots intact.
  if (/^(?:\\\\\?\\)?[A-Za-z]:[\\/]?$/.test(path)) return path;
  if (/^\\\\(?:\?\\UNC\\)?[^\\]+\\[^\\]+\\?$/.test(path)) return path;
  const p = path.replace(/[\\/]+$/, '');
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const parent = i < 0 ? path : p.slice(0, i);
  if (/^(?:\\\\\?\\)?[A-Za-z]:$/.test(parent)) return parent + p[i];
  return parent || '/';
}
export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024,
    i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${u[i]}`;
}
export function formatSpeed(bytesPerSecond: number | null | undefined) {
  return bytesPerSecond == null || !Number.isFinite(bytesPerSecond)
    ? '—'
    : `${formatSize(Math.max(0, bytesPerSecond))}/s`;
}
export function visibleEntries(
  entries: FileEntry[],
  filter: string,
  hidden: boolean,
  sort: 'name' | 'size' | 'modified',
  descending?: boolean,
) {
  return entries
    .filter(
      (e) =>
        (hidden || !e.name.startsWith('.')) && e.name.toLowerCase().includes(filter.toLowerCase()),
    )
    .sort((a, b) => {
      const group = Number(b.isDirectory) - Number(a.isDirectory);
      if (group) return group;
      const name = a.name.localeCompare(b.name);
      if (a.isDirectory && sort !== 'name') return name;
      const value =
        sort === 'name'
          ? name
          : sort === 'size'
            ? a.size - b.size
            : (Date.parse(a.modified || '') || 0) - (Date.parse(b.modified || '') || 0);
      return value * ((descending ?? sort === 'size') ? -1 : 1) || name;
    });
}
export function loadProfiles(): Profile[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem('better-ftp.profiles') || '[]');
    if (!Array.isArray(data)) return [];
    return data.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const p = value as Record<string, unknown>;
      const protocol =
        p.protocol ?? (typeof p.secure === 'boolean' ? (p.secure ? 'ftps' : 'ftp') : null);
      if (
        !['ftp', 'ftps', 'sftp'].includes(String(protocol)) ||
        typeof p.id !== 'string' ||
        typeof p.name !== 'string' ||
        typeof p.host !== 'string' ||
        typeof p.username !== 'string' ||
        !Number.isInteger(p.port) ||
        Number(p.port) < 1 ||
        Number(p.port) > 65535
      )
        return [];
      const authMethod =
        protocol === 'sftp' && ['privateKey', 'agent'].includes(String(p.authMethod))
          ? (p.authMethod as AuthMethod)
          : 'password';
      const timeout = Number(p.timeoutSeconds ?? 30);
      return [
        profileMetadata({
          id: p.id,
          name: p.name,
          host: p.host,
          port: Number(p.port),
          username: p.username,
          protocol: protocol as Protocol,
          authMethod,
          timeoutSeconds:
            Number.isInteger(timeout) && timeout >= 1 && timeout <= 300 ? timeout : 30,
          privateKeyPath: typeof p.privateKeyPath === 'string' ? p.privateKeyPath : undefined,
          localPath: typeof p.localPath === 'string' ? p.localPath : undefined,
          remotePath: typeof p.remotePath === 'string' ? p.remotePath : undefined,
        }),
      ];
    });
  } catch {
    return [];
  }
}
