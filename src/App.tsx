import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as Dialog from '@radix-ui/react-dialog';
import { Group, Panel, Separator } from 'react-resizable-panels';
import {
  Bars3Icon,
  PlusIcon,
  ServerIcon,
  XMarkIcon,
  EyeIcon,
  EllipsisHorizontalIcon,
  QueueListIcon,
  ChevronDownIcon,
  ShieldCheckIcon,
  ExclamationCircleIcon,
  ArrowPathIcon,
} from '@heroicons/react/16/solid';
import FilePane from './components/FilePane';
import ConnectionDialog from './components/ConnectionDialog';
import HostKeyDialog from './components/HostKeyDialog';
import { client, type HostKeyInfo } from './bridge';
import ConnectionSidebar from './components/ConnectionSidebar';
import TransferPanel, { type TransferView } from './components/TransferPanel';
import { Button, IconButton } from './components/ui/button';
import { Menu, MenuItem, MenuSeparator } from './components/ui/menu';
import { useWorkspace } from './state/use-workspace';
import { useCloseGuard } from './state/use-close-guard';
import type { Side } from './state/workspace';
import { formatSize, formatSpeed, type Profile } from './model';
const smallWindow = window.matchMedia('(max-width: 760px)');
function useSmallWindow() {
  return useSyncExternalStore(
    (callback) => {
      smallWindow.addEventListener('change', callback);
      return () => smallWindow.removeEventListener('change', callback);
    },
    () => smallWindow.matches,
  );
}
export default function App() {
  const { state, workspace } = useWorkspace();
  const closeGuard = useCloseGuard(workspace);
  const small = useSmallWindow();
  const [sidebar, setSidebar] = useState(() => !smallWindow.matches);
  const [transfers, setTransfers] = useState(true);
  const [transferView, setTransferView] = useState<TransferView>('queue');
  const [hidden, setHidden] = useState(false);
  const [activePane, setActivePane] = useState<Side>('local');
  const [dialog, setDialog] = useState<{ profile?: Profile } | null>(null);
  const [connectError, setConnectError] = useState('');
  const [checkingHost, setCheckingHost] = useState(false);
  const [hostKey, setHostKey] = useState<HostKeyInfo | null>(null);
  const [trusting, setTrusting] = useState(false);
  const [hostKeyError, setHostKeyError] = useState('');
  const pendingConnection = useRef<{ profile: Profile; password: string } | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const busy = workspace.busy();
  const operating =
    checkingHost ||
    hostKey !== null ||
    ['starting', 'connecting', 'disconnecting'].includes(state.phase);
  const connected = state.phase === 'connected';
  function open(profile?: Profile) {
    if (operating) return;
    setConnectError('');
    setDialog({ profile });
    if (small) setSidebar(false);
  }
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.repeat) return;
      const modal = document.querySelector('[role="dialog"]');
      if (modal) return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        open();
      } else if (key === 'b') {
        event.preventDefault();
        setSidebar((v) => !v);
      } else if (key === 'j') {
        event.preventDefault();
        setTransfers((v) => !v);
      } else if (key === 'h' && event.shiftKey) {
        event.preventDefault();
        setHidden((v) => !v);
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [state.phase, small]);
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
  async function finishConnect(profile: Profile, password: string) {
    try {
      await workspace.connect(profile, password);
      setDialog(null);
    } catch (error) {
      setConnectError(errorText(error));
    }
  }
  async function connect(profile: Profile, password: string) {
    setConnectError('');
    if (profile.protocol === 'sftp') {
      setCheckingHost(true);
      try {
        const info = await client.inspectHost(profile);
        if (info.status !== 'trusted') {
          pendingConnection.current = { profile, password };
          setHostKey(info);
          setHostKeyError('');
          return;
        }
      } catch (error) {
        setConnectError(errorText(error));
        return;
      } finally {
        setCheckingHost(false);
      }
    }
    await finishConnect(profile, password);
  }
  async function trustAndConnect() {
    const pending = pendingConnection.current;
    if (!hostKey || !pending) return;
    setTrusting(true);
    setHostKeyError('');
    try {
      await client.trustHost(hostKey, pending.profile.timeoutSeconds);
      pendingConnection.current = null;
      setHostKey(null);
      await finishConnect(pending.profile, pending.password);
    } catch (error) {
      setHostKeyError(errorText(error));
    } finally {
      setTrusting(false);
    }
  }
  function cancelHostTrust() {
    if (trusting) return;
    pendingConnection.current = null;
    setHostKey(null);
    setHostKeyError('');
  }
  const completed = state.queue.filter((t) => t.status === 'completed');
  const pending = state.queue.filter((t) => ['queued', 'running', 'cancelling'].includes(t.status));
  const failed = state.queue.filter((t) => t.status === 'failed');
  const pane = useCallback(
    (side: Side) => (
      <FilePane
        side={side}
        pane={state[side]}
        active={activePane === side}
        connected={connected}
        transferEnabled={
          connected &&
          !state.local.busy &&
          !state.remote.busy &&
          !state.local.error &&
          !state.remote.error
        }
        hidden={hidden}
        onHidden={() => setHidden((v) => !v)}
        onFocus={() => setActivePane(side)}
        onSelect={(selected) => workspace.select(side, selected)}
        onNavigate={(path) => void workspace.browse(side, path)}
        onHistory={(offset) => workspace.history(side, offset)}
        onRefresh={() => void workspace.refresh(side)}
        onTransfer={() => {
          setTransferView('queue');
          workspace.enqueue(side);
          setTransfers(true);
        }}
      />
    ),
    [state.local, state.remote, activePane, connected, hidden, workspace],
  );
  // Throughput ticks update the dock without rebuilding unchanged directory tables.
  const browser = useMemo(
    () => (
      <div className="file-workspace">
        {small ? (
          <>
            <div className="compact-tabs">
              <button
                type="button"
                aria-pressed={activePane === 'local'}
                onClick={() => setActivePane('local')}
              >
                Local
              </button>
              <button
                type="button"
                aria-pressed={activePane === 'remote'}
                onClick={() => setActivePane('remote')}
              >
                Remote
              </button>
            </div>
            {pane(activePane)}
          </>
        ) : (
          <Group orientation="horizontal" id="file-panes">
            <Panel id="local-pane" defaultSize="50%" minSize="28%">
              {pane('local')}
            </Panel>
            <Separator className="resize-handle" aria-label="Resize file panes" />
            <Panel id="remote-pane" defaultSize="50%" minSize="28%">
              {pane('remote')}
            </Panel>
          </Group>
        )}
      </div>
    ),
    [small, activePane, pane],
  );
  return (
    <Tooltip.Provider delayDuration={500}>
      <div className="app-shell">
        <Group orientation="horizontal" id="workspace-layout">
          {sidebar && !small && (
            <>
              <Panel id="connection-sidebar" defaultSize={224} minSize={180} maxSize={340}>
                <ConnectionSidebar
                  profiles={state.profiles}
                  session={state.session}
                  onOpen={open}
                  onRemove={workspace.removeProfile}
                  onClose={() => setSidebar(false)}
                  disabled={operating}
                />
              </Panel>
              <Separator
                className="resize-handle sidebar-resize"
                aria-label="Resize connections sidebar"
              />
            </>
          )}
          <Panel id="workspace-main" minSize={small ? 300 : 500}>
            <main className="main-workspace">
              <header className="workspace-toolbar">
                <IconButton
                  label="Toggle connections sidebar"
                  aria-pressed={sidebar}
                  onClick={() => setSidebar((v) => !v)}
                >
                  <Bars3Icon />
                </IconButton>
                <div className="session-tab">
                  <ServerIcon />
                  <span>{state.session?.name || 'No connection'}</span>
                  {state.session && (
                    <IconButton
                      label="Disconnect"
                      disabled={busy || operating}
                      onClick={() => void workspace.disconnect().catch(() => {})}
                    >
                      <XMarkIcon />
                    </IconButton>
                  )}
                </div>
                <div className="toolbar-spacer" />
                {!state.session && (
                  <Button
                    variant="primary"
                    disabled={operating || !workspace.available}
                    onClick={() => open()}
                  >
                    <PlusIcon />
                    Connect<kbd>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}N</kbd>
                  </Button>
                )}
                {state.session && (
                  <div
                    className={`connection-security ${state.session.protocol !== 'ftp' ? '' : 'insecure'}`}
                  >
                    {state.session.protocol !== 'ftp' ? (
                      <ShieldCheckIcon />
                    ) : (
                      <ExclamationCircleIcon />
                    )}
                    {state.session.protocol === 'ftp'
                      ? 'FTP · unencrypted'
                      : state.session.protocol.toUpperCase()}
                  </div>
                )}
                <IconButton
                  label={transfers ? 'Hide transfer panel' : 'Show transfer panel'}
                  aria-pressed={transfers}
                  onClick={() => setTransfers((v) => !v)}
                >
                  <QueueListIcon />
                </IconButton>
                <Menu
                  label="Workspace options"
                  trigger={
                    <IconButton label="Workspace options">
                      <EllipsisHorizontalIcon />
                    </IconButton>
                  }
                >
                  <MenuItem onSelect={() => setHidden((v) => !v)}>
                    <EyeIcon />
                    {hidden ? 'Hide hidden files' : 'Show hidden files'}
                  </MenuItem>
                  <MenuItem onSelect={() => setTransfers((v) => !v)}>
                    <QueueListIcon />
                    {transfers ? 'Hide transfers' : 'Show transfers'}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem onSelect={() => setShortcuts(true)}>Keyboard shortcuts</MenuItem>
                </Menu>
              </header>
              {state.error && (
                <div className="application-error" role="alert">
                  <span>{state.error}</span>
                  <IconButton label="Dismiss error" onClick={workspace.clearError}>
                    <XMarkIcon />
                  </IconButton>
                </div>
              )}
              <div className="workspace-content">
                {transfers ? (
                  <Group orientation="vertical" id="browser-and-transfers">
                    <Panel id="browser-area" defaultSize="74%" minSize={220}>
                      {browser}
                    </Panel>
                    <Separator
                      className="resize-handle horizontal"
                      aria-label="Resize transfer panel"
                    />
                    <Panel id="transfer-area" defaultSize="26%" minSize={130} maxSize="55%">
                      <TransferPanel
                        tab={transferView}
                        setTab={setTransferView}
                        state={state}
                        workspace={workspace}
                        onClose={() => setTransfers(false)}
                      />
                    </Panel>
                  </Group>
                ) : (
                  browser
                )}
              </div>
              <footer className="status-bar">
                <div>
                  <span className={`status-dot ${connected ? 'connected' : ''}`} />
                  <span>
                    {!workspace.available
                      ? 'Desktop runtime unavailable'
                      : state.phase === 'starting'
                        ? 'Initializing…'
                        : state.phase === 'connecting'
                          ? 'Connecting…'
                          : state.phase === 'disconnecting'
                            ? 'Disconnecting…'
                            : connected
                              ? `${state.session!.username}@${state.session!.host}:${state.session!.port}`
                              : 'Disconnected'}
                  </span>
                  {operating && <ArrowPathIcon className="spinning" />}
                </div>
                <div>
                  {pending.some((t) => t.status === 'running') && (
                    <span className="live-transfer-speed" aria-label="Total transfer speed">
                      {formatSpeed(
                        pending.filter((t) => t.status === 'running').some((t) => t.speed != null)
                          ? pending
                              .filter((t) => t.status === 'running')
                              .reduce((sum, t) => sum + (t.speed || 0), 0)
                          : null,
                      )}
                    </span>
                  )}
                  <span>{pending.length} queued</span>
                  {failed.length > 0 && (
                    <button
                      type="button"
                      className="status-failures"
                      onClick={() => {
                        setTransferView('failed');
                        setTransfers(true);
                      }}
                    >
                      {failed.length} failed
                    </button>
                  )}
                  <span>
                    {formatSize(completed.reduce((sum, t) => sum + t.bytes, 0))} transferred
                  </span>
                  <button
                    type="button"
                    aria-label="Toggle transfer panel"
                    onClick={() => setTransfers((v) => !v)}
                  >
                    <ChevronDownIcon className={transfers ? '' : 'sort-up'} />
                  </button>
                </div>
              </footer>
            </main>
          </Panel>
        </Group>
        {small && sidebar && (
          <div className="mobile-sidebar-overlay">
            <button
              type="button"
              className="sidebar-backdrop"
              aria-label="Close connections sidebar"
              onClick={() => setSidebar(false)}
            />
            <ConnectionSidebar
              profiles={state.profiles}
              session={state.session}
              onOpen={open}
              onRemove={workspace.removeProfile}
              onClose={() => setSidebar(false)}
              disabled={operating}
            />
          </div>
        )}
        {dialog && (
          <ConnectionDialog
            key={dialog.profile?.id || 'new'}
            profile={dialog.profile}
            onPickPath={workspace.pickPath}
            connected={!!state.session}
            busy={state.phase === 'connecting' || checkingHost || hostKey !== null}
            error={connectError}
            onClose={() => setDialog(null)}
            onConnect={(p, password) => void connect(p, password)}
            onSave={(p) => {
              if (workspace.saveProfile(p)) setDialog(null);
            }}
            onDelete={(id) => {
              workspace.removeProfile(id);
              setDialog(null);
            }}
          />
        )}
        {hostKey && (
          <HostKeyDialog
            info={hostKey}
            busy={trusting}
            error={hostKeyError}
            onCancel={cancelHostTrust}
            onTrust={() => void trustAndConnect()}
          />
        )}
        <Dialog.Root
          open={closeGuard.requested}
          onOpenChange={(open) => {
            if (!open && !closeGuard.closing) closeGuard.keepOpen();
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content className="dialog-content">
              <div className="dialog-heading">
                <Dialog.Title>Transfers in progress</Dialog.Title>
              </div>
              <Dialog.Description className="dialog-description">
                Closing this window will cancel active and queued transfers. A partial upload may
                remain on the server.
              </Dialog.Description>
              {closeGuard.error && (
                <p role="alert" className="form-error">
                  {closeGuard.error}
                </p>
              )}
              <div className="dialog-actions">
                <Button
                  variant="danger"
                  disabled={closeGuard.closing}
                  onClick={() => void closeGuard.cancelAndClose()}
                >
                  {closeGuard.closing ? 'Cancelling…' : 'Cancel transfers and close'}
                </Button>
                <Button
                  variant="primary"
                  disabled={closeGuard.closing}
                  autoFocus
                  onClick={closeGuard.keepOpen}
                >
                  Keep open
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <Dialog.Root open={shortcuts} onOpenChange={setShortcuts}>
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content className="dialog-content shortcut-dialog">
              <div className="dialog-heading">
                <Dialog.Title>Keyboard shortcuts</Dialog.Title>
                <IconButton label="Close keyboard shortcuts" onClick={() => setShortcuts(false)}>
                  <XMarkIcon />
                </IconButton>
              </div>
              <Dialog.Description className="sr-only">
                Workspace and file navigation shortcuts.
              </Dialog.Description>
              <dl>
                {[
                  ['New connection', 'Mod N'],
                  ['Toggle connections', 'Mod B'],
                  ['Toggle transfers', 'Mod J'],
                  ['Toggle hidden files', 'Mod Shift H'],
                  ['Select all files', 'Mod A'],
                  ['Parent directory', 'Backspace'],
                  ['Open selected folder', 'Enter'],
                  ['Refresh directory', 'F5'],
                ].map(([name, key]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>
                      <kbd>
                        {key.replace('Mod', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')}
                      </kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </Tooltip.Provider>
  );
}
