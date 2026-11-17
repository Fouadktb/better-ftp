import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import {
  XMarkIcon,
  LockClosedIcon,
  ArrowPathIcon,
  FolderOpenIcon,
} from '@heroicons/react/16/solid';
import { defaultPort, type Profile, type Protocol, type AuthMethod } from '../model';
import { Button, IconButton } from './ui/button';
type Tab = 'connection' | 'directories' | 'advanced';
export default function ConnectionDialog({
  profile,
  reconnecting,
  busy,
  aborting,
  onAbort,
  error,
  connected,
  onClose,
  onConnect,
  onSave,
  onDelete,
  onPickPath,
}: {
  profile?: Profile;
  reconnecting: boolean;
  busy: boolean;
  aborting: boolean;
  onAbort: () => void;
  error: string;
  connected: boolean;
  onClose: () => void;
  onConnect: (p: Profile, password: string) => void;
  onSave: (p: Profile) => void;
  onDelete: (id: string) => void;
  onPickPath: (kind: 'key' | 'directory') => Promise<string | null>;
}) {
  const [protocol, setProtocol] = useState<Protocol>(profile?.protocol ?? 'sftp');
  const [authMethod, setAuthMethod] = useState<AuthMethod>(profile?.authMethod ?? 'password');
  const [port, setPort] = useState(String(profile?.port ?? 22));
  const [tab, setTab] = useState<Tab>('connection');
  const [validation, setValidation] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const localRef = useRef<HTMLInputElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const initial = useRef({
    name: profile?.name.trim() ?? '',
    host: profile?.host.trim() ?? '',
    username: profile?.username ?? '',
    port: profile?.port ?? 22,
    protocol: profile?.protocol ?? 'sftp',
    authMethod: profile?.authMethod ?? 'password',
    privateKeyPath: profile?.privateKeyPath ?? '',
    localPath: profile?.localPath ?? '',
    remotePath: profile?.remotePath ?? '',
    timeoutSeconds: profile?.timeoutSeconds ?? 30,
  });
  function requestClose() {
    if (busy || picking || discardOpen) return;
    const form = formRef.current;
    if (form) {
      const data = new FormData(form);
      const dirty =
        (['name', 'host', 'username', 'privateKeyPath', 'localPath', 'remotePath'] as const).some(
          (field) => String(data.get(field) ?? '').trim() !== initial.current[field],
        ) ||
        Number(data.get('port')) !== initial.current.port ||
        protocol !== initial.current.protocol ||
        authMethod !== initial.current.authMethod ||
        Number(data.get('timeoutSeconds')) !== initial.current.timeoutSeconds ||
        !!secretRef.current?.value;
      if (dirty) {
        returnFocusRef.current = document.activeElement as HTMLElement;
        setDiscardOpen(true);
        return;
      }
    }
    onClose();
  }
  function validate(form: HTMLFormElement) {
    if (!form.checkValidity()) {
      const invalid = form.querySelector<HTMLInputElement>(':invalid');
      setTab(
        (invalid?.closest('[data-connection-tab]')?.getAttribute('data-connection-tab') as Tab) ||
          'connection',
      );
      requestAnimationFrame(() => form.reportValidity());
      return;
    }
    const data = new FormData(form);
    const host = String(data.get('host'))
      .trim()
      .replace(/^\[|\]$/g, '');
    if (!host || /[\s/\\\r\n]/.test(host) || host.includes('://')) {
      setTab('connection');
      setValidation('Enter a hostname or IP address without a protocol or path.');
      return;
    }
    return {
      id: profile?.id || crypto.randomUUID(),
      name: String(data.get('name') || host).trim(),
      host,
      port: Number(data.get('port')),
      username: String(data.get('username')),
      protocol,
      authMethod: protocol === 'sftp' ? authMethod : 'password',
      timeoutSeconds: Number(data.get('timeoutSeconds')),
      privateKeyPath:
        protocol === 'sftp' && authMethod === 'privateKey'
          ? String(data.get('privateKeyPath') || '').trim()
          : undefined,
      localPath: String(data.get('localPath') || '').trim() || undefined,
      remotePath: String(data.get('remotePath') || '').trim() || undefined,
    } as Profile;
  }
  async function browse(kind: 'key' | 'directory') {
    setPicking(true);
    setValidation('');
    try {
      const path = await onPickPath(kind);
      const input = kind === 'key' ? keyRef.current : localRef.current;
      if (path && input) input.value = path;
    } catch (e) {
      setValidation(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  }
  const passwordRequired = protocol !== 'sftp' || authMethod === 'password';
  const keyAuth = protocol === 'sftp' && authMethod === 'privateKey';
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content connection-dialog"
          onOpenAutoFocus={(event) => {
            if (reconnecting && secretRef.current) {
              event.preventDefault();
              secretRef.current.focus();
            }
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            if (discardOpen) setDiscardOpen(false);
            else requestClose();
          }}
          onKeyDownCapture={(event) => {
            if (event.key === 'Escape' && !event.defaultPrevented) {
              event.preventDefault();
              event.stopPropagation();
              if (discardOpen) setDiscardOpen(false);
              else requestClose();
            }
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
            requestClose();
          }}
        >
          <div className="dialog-heading">
            <Dialog.Title>
              {reconnecting ? 'Reconnect' : profile ? 'Edit connection' : 'New connection'}
            </Dialog.Title>
            <IconButton
              label="Close connection dialog"
              disabled={busy || picking}
              onClick={requestClose}
            >
              <XMarkIcon />
            </IconButton>
          </div>
          <Dialog.Description className="dialog-description">
            {connected
              ? 'Disconnect the current session before connecting to another server.'
              : 'Server settings and authentication. Passwords and passphrases are not saved.'}
          </Dialog.Description>
          <form
            ref={formRef}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const next = validate(event.currentTarget);
              if (next) onConnect(next, secretRef.current?.value || '');
            }}
          >
            <fieldset disabled={busy || picking}>
              <Tabs.Root value={tab} onValueChange={(value) => setTab(value as Tab)}>
                <Tabs.List className="connection-tabs" aria-label="Connection settings">
                  <Tabs.Trigger value="connection">Connection</Tabs.Trigger>
                  <Tabs.Trigger value="directories">Directories</Tabs.Trigger>
                  <Tabs.Trigger value="advanced">Advanced</Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content
                  value="connection"
                  forceMount
                  hidden={tab !== 'connection'}
                  data-connection-tab="connection"
                  className="connection-tab"
                >
                  <label>
                    Connection name
                    <input
                      name="name"
                      autoFocus
                      defaultValue={profile?.name}
                      placeholder="Optional"
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Protocol
                    <select
                      name="protocol"
                      value={protocol}
                      onChange={(event) => {
                        const next = event.target.value as Protocol;
                        if (!port || Number(port) === defaultPort(protocol))
                          setPort(String(defaultPort(next)));
                        setProtocol(next);
                        setValidation('');
                      }}
                    >
                      <option value="sftp">SFTP — SSH File Transfer Protocol</option>
                      <option value="ftps">FTPS — FTP over TLS (explicit)</option>
                      <option value="ftp">FTP — File Transfer Protocol</option>
                    </select>
                  </label>
                  <div className="host-fields">
                    <label>
                      Host
                      <input
                        name="host"
                        required
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        defaultValue={profile?.host}
                        placeholder="server.example.com"
                      />
                    </label>
                    <label>
                      Port
                      <input
                        name="port"
                        type="number"
                        required
                        min={1}
                        max={65535}
                        value={port}
                        onChange={(event) => setPort(event.target.value)}
                      />
                    </label>
                  </div>
                  {protocol === 'sftp' && (
                    <label>
                      Authentication
                      <select
                        name="authMethod"
                        value={authMethod}
                        onChange={(event) => setAuthMethod(event.target.value as AuthMethod)}
                      >
                        <option value="password">Password</option>
                        <option value="privateKey">Private key file</option>
                        <option value="agent">SSH agent</option>
                      </select>
                    </label>
                  )}
                  <label>
                    Username
                    <input
                      name="username"
                      autoComplete="username"
                      required
                      defaultValue={profile?.username}
                    />
                  </label>
                  <label hidden={!keyAuth}>
                    Private key file
                    <div className="path-picker">
                      <input
                        ref={keyRef}
                        aria-label="Private key file"
                        name="privateKeyPath"
                        defaultValue={profile?.privateKeyPath}
                        required={keyAuth}
                        placeholder="Path to your SSH private key"
                      />
                      <IconButton label="Browse SSH private key" onClick={() => void browse('key')}>
                        <FolderOpenIcon />
                      </IconButton>
                    </div>
                  </label>
                  <label hidden={!passwordRequired && !keyAuth}>
                    {keyAuth ? 'Key passphrase' : 'Password'}
                    <input
                      ref={secretRef}
                      name="password"
                      type="password"
                      autoComplete="off"
                      placeholder={keyAuth ? 'Optional for an unencrypted key' : undefined}
                    />
                  </label>
                  {protocol === 'sftp' && authMethod === 'agent' && (
                    <p className="setting-note">
                      Uses keys loaded in your running SSH agent. Agent confirmation may be
                      required.
                    </p>
                  )}
                </Tabs.Content>
                <Tabs.Content
                  value="directories"
                  forceMount
                  hidden={tab !== 'directories'}
                  data-connection-tab="directories"
                  className="connection-tab"
                >
                  <label>
                    Default local directory
                    <div className="path-picker">
                      <input
                        ref={localRef}
                        aria-label="Default local directory"
                        name="localPath"
                        defaultValue={profile?.localPath}
                        placeholder="Keep the current local directory"
                      />
                      <IconButton
                        label="Browse default local directory"
                        onClick={() => void browse('directory')}
                      >
                        <FolderOpenIcon />
                      </IconButton>
                    </div>
                  </label>
                  <label>
                    Default remote directory
                    <input
                      name="remotePath"
                      defaultValue={profile?.remotePath}
                      placeholder="Server home directory"
                    />
                  </label>
                  <p className="setting-note">
                    These directories open when you connect. Leave them empty to use the current
                    local directory and the server’s home directory.
                  </p>
                </Tabs.Content>
                <Tabs.Content
                  value="advanced"
                  forceMount
                  hidden={tab !== 'advanced'}
                  data-connection-tab="advanced"
                  className="connection-tab"
                >
                  <label>
                    Timeout in seconds
                    <input
                      name="timeoutSeconds"
                      type="number"
                      required
                      min={1}
                      max={300}
                      defaultValue={profile?.timeoutSeconds ?? 30}
                    />
                  </label>
                  <p className="setting-note">
                    Connection and network operations time out after this interval.
                  </p>
                  <div className="connection-facts">
                    <div>
                      <span>Transfers</span>
                      <span>One file at a time</span>
                    </div>
                    <div>
                      <span>Existing files</span>
                      <span>Refuse replacement</span>
                    </div>
                    {protocol !== 'sftp' && (
                      <div>
                        <span>FTP transfer mode</span>
                        <span>Passive</span>
                      </div>
                    )}
                  </div>
                </Tabs.Content>
              </Tabs.Root>
            </fieldset>
            {protocol === 'ftp' && (
              <p className="warning">FTP transmits credentials and files without encryption.</p>
            )}
            {(error || validation) && (
              <p className="form-error" role="alert">
                {error || validation}
              </p>
            )}
            <div className="credential-note">
              <LockClosedIcon />
              <span>Only connection settings are stored on this device.</span>
            </div>
            <div className="dialog-actions">
              {busy && (
                <Button disabled={aborting} onClick={onAbort}>
                  <XMarkIcon />
                  {aborting ? 'Aborting…' : 'Abort connection'}
                </Button>
              )}
              {profile && (
                <Button
                  variant="danger"
                  disabled={busy || picking}
                  className="remove-profile"
                  onClick={() => onDelete(profile.id)}
                >
                  Remove
                </Button>
              )}
              <Button
                disabled={busy || picking}
                onClick={() => {
                  const next = validate(formRef.current!);
                  if (next) onSave(next);
                }}
              >
                Save
              </Button>
              <Button type="submit" variant="primary" disabled={busy || picking || connected}>
                {busy && <ArrowPathIcon className="spinning" />}
                {busy ? 'Connecting…' : reconnecting ? 'Reconnect' : 'Connect'}
              </Button>
            </div>
          </form>
          <AlertDialog.Root open={discardOpen} onOpenChange={setDiscardOpen}>
            <AlertDialog.Portal>
              <AlertDialog.Overlay className="dialog-overlay discard-overlay" />
              <AlertDialog.Content
                className="dialog-content discard-content"
                onEscapeKeyDown={(event) => {
                  event.preventDefault();
                  event.stopImmediatePropagation();
                  setDiscardOpen(false);
                }}
                onOpenAutoFocus={(event) => {
                  event.preventDefault();
                  keepEditingRef.current?.focus();
                }}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  returnFocusRef.current?.focus();
                }}
              >
                <div className="dialog-heading">
                  <AlertDialog.Title>Discard connection changes?</AlertDialog.Title>
                </div>
                <AlertDialog.Description className="dialog-description">
                  Your unsaved connection details and password will be discarded.
                </AlertDialog.Description>
                <div className="dialog-actions">
                  <AlertDialog.Cancel ref={keepEditingRef} className="button button-outline">
                    Keep editing
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <Button variant="danger" onClick={onClose}>
                      Discard changes
                    </Button>
                  </AlertDialog.Action>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
