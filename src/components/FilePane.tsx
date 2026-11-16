import { useRef, useState, useEffect, type KeyboardEvent, type MouseEvent } from 'react';
import {
  ArrowUpIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowPathIcon,
  FolderIcon,
  DocumentIcon,
  CodeBracketIcon,
  PhotoIcon,
  MagnifyingGlassIcon,
  ComputerDesktopIcon,
  ServerIcon,
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  ChevronDownIcon,
  EyeIcon,
  EllipsisHorizontalIcon,
} from '@heroicons/react/16/solid';
import { formatSize, parentPath, visibleEntries, type FileEntry } from '../model';
import type { PaneState, Side } from '../state/workspace';
import { Button, IconButton } from './ui/button';
import { Menu, MenuItem } from './ui/menu';
interface Props {
  side: Side;
  pane: PaneState;
  connected: boolean;
  transferEnabled: boolean;
  hidden: boolean;
  onHidden: () => void;
  onSelect: (paths: string[]) => void;
  onNavigate: (path: string) => void;
  onHistory: (offset: number) => void;
  onRefresh: () => void;
  onTransfer: () => void;
  onFocus: () => void;
  active: boolean;
}
function FileIcon({ entry }: { entry: FileEntry }) {
  if (entry.isDirectory) return <FolderIcon className="folder-icon" />;
  if (/\.(png|jpe?g|svg|gif|webp|ico)$/i.test(entry.name)) return <PhotoIcon />;
  if (/\.(js|tsx?|jsx|json|html|css|rs|toml|ya?ml)$/i.test(entry.name)) return <CodeBracketIcon />;
  return <DocumentIcon />;
}
export default function FilePane(p: Props) {
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'name' | 'size' | 'modified'>('name');
  const [descending, setDescending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const anchor = useRef<string | null>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const isLocal = p.side === 'local';
  const available = isLocal || p.connected;
  const enabled = available && !p.pane.busy && !p.pane.error;
  const entries = visibleEntries(p.pane.entries, filter, p.hidden, sort, descending);
  const selected = p.pane.selected;
  const files = p.pane.entries.filter((e) => selected.includes(e.path) && !e.isDirectory);
  useEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate =
        entries.some((e) => selected.includes(e.path)) &&
        !entries.every((e) => selected.includes(e.path));
  }, [entries, selected]);
  function choose(e: FileEntry, event: MouseEvent) {
    if (event.shiftKey && anchor.current) {
      const a = entries.findIndex((x) => x.path === anchor.current),
        b = entries.indexOf(e);
      if (a >= 0) {
        p.onSelect(entries.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path));
        return;
      }
    }
    anchor.current = e.path;
    p.onSelect(
      event.metaKey || event.ctrlKey
        ? selected.includes(e.path)
          ? selected.filter((x) => x !== e.path)
          : [...selected, e.path]
        : [e.path],
    );
  }
  function keys(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT') return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
      event.preventDefault();
      p.onSelect(entries.map((e) => e.path));
    }
    if (event.key === 'Escape') p.onSelect([]);
    if (event.key === 'Backspace' && enabled) {
      event.preventDefault();
      p.onNavigate(parentPath(p.pane.path));
    }
    if (event.key === 'F5') {
      event.preventDefault();
      p.onRefresh();
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const buttons = Array.from(
        event.currentTarget.querySelectorAll<HTMLButtonElement>('.file-name'),
      );
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = Math.max(
        0,
        Math.min(buttons.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)),
      );
      buttons[next]?.focus();
      event.preventDefault();
    }
  }
  const sortBy = (value: typeof sort) => {
    setSort(value);
    setDescending(sort === value ? !descending : false);
  };
  return (
    <section
      className={`file-pane ${p.side} ${p.active ? 'pane-active' : ''}`}
      aria-label={isLocal ? 'Local files' : 'Remote files'}
      onFocusCapture={p.onFocus}
      onPointerDown={p.onFocus}
      onKeyDown={keys}
    >
      <header className="pane-heading">
        <div className="pane-label">
          {isLocal ? <ComputerDesktopIcon /> : <ServerIcon />}
          <h2>{isLocal ? 'Local' : 'Remote'}</h2>
        </div>
        <div className="pane-actions">
          <Button
            variant="ghost"
            className="transfer-button"
            disabled={!p.transferEnabled || !files.length || !enabled}
            onClick={p.onTransfer}
          >
            {isLocal ? <ArrowUpTrayIcon /> : <ArrowDownTrayIcon />}
            {isLocal ? 'Upload' : 'Download'}
            {files.length > 0 && <span className="count">{files.length}</span>}
          </Button>
          <Menu
            label={`${p.side} pane options`}
            trigger={
              <IconButton label={`${p.side} pane options`}>
                <EllipsisHorizontalIcon />
              </IconButton>
            }
          >
            <MenuItem onSelect={p.onHidden}>
              <EyeIcon />
              {p.hidden ? 'Hide hidden files' : 'Show hidden files'}
            </MenuItem>
            <MenuItem disabled={!available || p.pane.busy} onSelect={p.onRefresh}>
              <ArrowPathIcon />
              Refresh
            </MenuItem>
          </Menu>
        </div>
      </header>
      <div className="path-toolbar">
        <IconButton
          label={`Back in ${p.side}`}
          disabled={!enabled || p.pane.historyIndex <= 0}
          onClick={() => p.onHistory(-1)}
        >
          <ArrowLeftIcon />
        </IconButton>
        <IconButton
          label={`Forward in ${p.side}`}
          disabled={!enabled || p.pane.historyIndex >= p.pane.history.length - 1}
          onClick={() => p.onHistory(1)}
        >
          <ArrowRightIcon />
        </IconButton>
        <IconButton
          label={`${p.side} parent folder`}
          disabled={!enabled || !p.pane.path || parentPath(p.pane.path) === p.pane.path}
          onClick={() => p.onNavigate(parentPath(p.pane.path))}
        >
          <ArrowUpIcon />
        </IconButton>
        <form
          className="path-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (available && !p.pane.busy && draft.trim()) {
              p.onNavigate(draft.trim());
              setEditing(false);
              pathInput.current?.blur();
            }
          }}
        >
          <input
            ref={pathInput}
            name={`${p.side}-path`}
            aria-label={`${p.side} folder path`}
            value={editing ? draft : p.pane.path}
            placeholder={available ? 'Folder path' : 'Not connected'}
            disabled={!available || p.pane.busy}
            spellCheck={false}
            autoComplete="off"
            onFocus={() => {
              setDraft(p.pane.path);
              setEditing(true);
            }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setEditing(false);
                pathInput.current?.blur();
                e.stopPropagation();
              }
            }}
          />
        </form>
        <IconButton
          label={`Refresh ${p.side} files`}
          disabled={!available || p.pane.busy}
          onClick={p.onRefresh}
        >
          <ArrowPathIcon className={p.pane.busy ? 'spinning' : ''} />
        </IconButton>
      </div>
      <label className="pane-filter">
        <MagnifyingGlassIcon />
        <input
          ref={filterInput}
          name={`${p.side}-filter`}
          aria-label={`Filter ${p.side} files`}
          placeholder="Filter files"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          disabled={!available}
        />
        {filter && (
          <Button
            variant="ghost"
            onClick={() => setFilter('')}
            aria-label={`Clear ${p.side} filter`}
          >
            ×
          </Button>
        )}
      </label>
      <div className="file-scroll" aria-busy={p.pane.busy}>
        <table aria-label={`${p.side} directory`}>
          <thead>
            <tr>
              <th className="check-cell">
                <input
                  ref={selectAll}
                  type="checkbox"
                  name={`${p.side}-select-all`}
                  aria-label={`Select all ${p.side} files`}
                  disabled={!enabled || !entries.length}
                  checked={entries.length > 0 && entries.every((e) => selected.includes(e.path))}
                  onChange={(e) => p.onSelect(e.target.checked ? entries.map((x) => x.path) : [])}
                />
              </th>
              {(['name', 'size', 'modified'] as const).map((value) => (
                <th
                  key={value}
                  className={value}
                  aria-sort={sort === value ? (descending ? 'descending' : 'ascending') : 'none'}
                >
                  <button type="button" disabled={!available} onClick={() => sortBy(value)}>
                    {value === 'name' ? 'Name' : value === 'size' ? 'Size' : 'Modified'}
                    {sort === value && <ChevronDownIcon className={descending ? '' : 'sort-up'} />}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!p.pane.busy &&
              !p.pane.error &&
              available &&
              entries.map((e) => (
                <tr key={e.path} data-selected={selected.includes(e.path)}>
                  <td className="check-cell">
                    <input
                      type="checkbox"
                      name={e.path}
                      aria-label={`Select ${e.name}`}
                      checked={selected.includes(e.path)}
                      onChange={(event) =>
                        p.onSelect(
                          event.target.checked
                            ? [...selected, e.path]
                            : selected.filter((x) => x !== e.path),
                        )
                      }
                    />
                  </td>
                  <td className="name">
                    <button
                      type="button"
                      className="file-name"
                      title={e.name}
                      onClick={(event) => choose(e, event)}
                      onDoubleClick={() => {
                        if (e.isDirectory) p.onNavigate(e.path);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          if (e.isDirectory) p.onNavigate(e.path);
                          else if (p.transferEnabled) {
                            p.onSelect([
                              e.path,
                            ]); /* Transfer uses committed selection; Enter only selects files. */
                          }
                        }
                        if (event.key === ' ') {
                          event.preventDefault();
                          p.onSelect(
                            selected.includes(e.path)
                              ? selected.filter((x) => x !== e.path)
                              : [...selected, e.path],
                          );
                        }
                      }}
                    >
                      <FileIcon entry={e} />
                      <span>{e.name}</span>
                    </button>
                  </td>
                  <td className="size">{e.isDirectory ? '—' : formatSize(e.size)}</td>
                  <td
                    className="modified"
                    title={e.modified ? new Date(e.modified).toLocaleString() : undefined}
                  >
                    {e.modified
                      ? new Date(e.modified).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })
                      : '—'}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {p.pane.busy ? (
          <div className="pane-message" role="status">
            Loading directory…
          </div>
        ) : p.pane.error ? (
          <div className="pane-message pane-error" role="alert">
            <p>{p.pane.error}</p>
            {available && <Button onClick={p.onRefresh}>Retry</Button>}
          </div>
        ) : !available ? (
          <div className="pane-message">
            <p>Not connected</p>
          </div>
        ) : !entries.length ? (
          <div className="pane-message">{filter ? 'No matching files' : 'Empty directory'}</div>
        ) : null}
      </div>
      <footer className="pane-footer">
        <span>
          {entries.length} {entries.length === 1 ? 'item' : 'items'}
          {filter && ' (filtered)'}
        </span>
        <span>
          {selected.length
            ? `${selected.length} selected`
            : formatSize(entries.filter((e) => !e.isDirectory).reduce((n, e) => n + e.size, 0))}
        </span>
      </footer>
    </section>
  );
}
