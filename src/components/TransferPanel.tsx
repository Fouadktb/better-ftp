import * as Tabs from '@radix-ui/react-tabs';
import {
  ArrowPathIcon,
  PauseIcon,
  PlayIcon,
  XMarkIcon,
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
} from '@heroicons/react/16/solid';
import type { Workspace, WorkspaceState } from '../state/workspace';
import { formatSize, formatSpeed } from '../model';
import { Button, IconButton } from './ui/button';
const labels = {
  queued: 'Queued',
  running: 'Transferring',
  cancelling: 'Cancelling',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
export type TransferView = 'queue' | 'completed' | 'failed' | 'log';
export default function TransferPanel({
  state,
  workspace,
  onClose,
  tab,
  setTab,
}: {
  state: WorkspaceState;
  workspace: Workspace;
  onClose: () => void;
  tab: TransferView;
  setTab: (view: TransferView) => void;
}) {
  const pending = state.queue.filter((t) => ['queued', 'running', 'cancelling'].includes(t.status));
  const done = state.queue.filter((t) => t.status === 'completed');
  const failed = state.queue.filter((t) => t.status === 'failed');
  const shown = state.queue.filter((t) =>
    tab === 'queue'
      ? ['queued', 'running', 'cancelling', 'cancelled'].includes(t.status)
      : t.status === tab,
  );
  return (
    <Tabs.Root value={tab} onValueChange={(value) => setTab(value as typeof tab)} asChild>
      <section className="transfer-panel" aria-label="Transfers">
        <header className="transfer-header">
          <Tabs.List className="transfer-tabs" aria-label="Transfer views">
            {(
              [
                { id: 'queue', label: 'Queue', count: pending.length },
                { id: 'completed', label: 'Completed', count: done.length },
                { id: 'failed', label: 'Failed', count: failed.length },
                { id: 'log', label: 'Log', count: 0 },
              ] as const
            ).map((t) => (
              <Tabs.Trigger key={t.id} value={t.id}>
                {t.label}
                {t.count > 0 && <span className="count">{t.count}</span>}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <div className="transfer-controls">
            {tab === 'log' ? (
              <Button variant="ghost" disabled={!state.logs.length} onClick={workspace.clearLogs}>
                Clear log
              </Button>
            ) : (
              <>
                <IconButton
                  label={state.paused ? 'Resume queue' : 'Pause queue'}
                  disabled={!pending.length}
                  onClick={() => workspace.pause(!state.paused)}
                >
                  {state.paused ? <PlayIcon /> : <PauseIcon />}
                </IconButton>
                <Button
                  variant="ghost"
                  disabled={
                    !state.queue.some((t) =>
                      ['completed', 'failed', 'cancelled'].includes(t.status),
                    )
                  }
                  onClick={workspace.clearFinished}
                >
                  Clear finished
                </Button>
              </>
            )}
            <IconButton label="Hide transfers" onClick={onClose}>
              <XMarkIcon />
            </IconButton>
          </div>
        </header>
        <Tabs.Content
          value={tab}
          className="transfer-body"
          aria-label={tab === 'log' ? 'Activity log' : `${tab} transfers`}
        >
          {tab === 'log' ? (
            <div className="log-entries">
              {state.logs.length === 0 ? (
                <div className="panel-empty">No activity</div>
              ) : (
                state.logs.map((entry) => (
                  <div className={`log-entry ${entry.level}`} key={entry.id}>
                    <time>
                      {new Date(entry.time).toLocaleTimeString(undefined, { hour12: false })}
                    </time>
                    <span>{entry.message}</span>
                  </div>
                ))
              )}
            </div>
          ) : (
            <>
              <table className="transfer-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th className="transfer-destination">Destination</th>
                    <th>Size</th>
                    <th className="transfer-speed">Speed</th>
                    <th>Status</th>
                    <th className="transfer-action">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((t) => (
                    <tr key={t.id} className={`transfer-row ${t.status}`}>
                      <td>
                        <div className="transfer-name">
                          {t.direction === 'upload' ? <ArrowUpTrayIcon /> : <ArrowDownTrayIcon />}
                          <span title={t.source}>{t.name}</span>
                        </div>
                      </td>
                      <td className="transfer-destination">
                        <div title={t.destination}>{t.destination}</div>
                      </td>
                      <td className="size">{formatSize(t.size)}</td>
                      <td
                        className="transfer-speed"
                        title={
                          t.status === 'completed'
                            ? 'Average transfer speed'
                            : t.status === 'running'
                              ? 'Current transfer speed'
                              : undefined
                        }
                      >
                        {['running', 'completed'].includes(t.status) ? (
                          <span aria-label={`${t.name} transfer speed`}>
                            {formatSpeed(t.speed)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <div className={`transfer-state ${t.status}`}>
                          {t.status === 'completed' ? (
                            <CheckCircleIcon />
                          ) : t.status === 'failed' ? (
                            <ExclamationCircleIcon />
                          ) : t.status === 'running' ? (
                            <ArrowPathIcon className="spinning" />
                          ) : null}
                          <span>
                            {t.status === 'running' && t.total !== null && t.bytes >= t.total
                              ? 'Finalizing'
                              : labels[t.status]}
                            {t.status === 'running' && t.total !== null
                              ? ` · ${Math.min(100, Math.floor((t.bytes / Math.max(1, t.total)) * 100))}%`
                              : ''}
                          </span>
                        </div>
                        {t.error && (
                          <p className="transfer-error" title={t.error}>
                            {t.error}
                          </p>
                        )}
                        {['running', 'cancelling'].includes(t.status) && (
                          <progress
                            aria-label={`${t.name} progress`}
                            value={t.total === null ? undefined : t.bytes}
                            max={t.total || 1}
                          />
                        )}
                      </td>
                      <td className="transfer-action">
                        {['queued', 'running', 'cancelling'].includes(t.status) ? (
                          <IconButton
                            label={`Cancel ${t.name}`}
                            disabled={t.status === 'cancelling'}
                            onClick={() => void workspace.cancel(t.id)}
                          >
                            <XMarkIcon />
                          </IconButton>
                        ) : t.status === 'failed' ? (
                          <IconButton
                            label={`Retry ${t.name}`}
                            disabled={state.session?.id !== t.sessionId}
                            onClick={() => workspace.retry(t.id)}
                          >
                            <ArrowPathIcon />
                          </IconButton>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!shown.length && (
                <div className="panel-empty">
                  {tab === 'queue'
                    ? 'No queued transfers'
                    : tab === 'completed'
                      ? 'No completed transfers'
                      : 'No failed transfers'}
                </div>
              )}
            </>
          )}
        </Tabs.Content>
      </section>
    </Tabs.Root>
  );
}
