import appIcon from '../../assets/app-icon-small.png';
import { version } from '../../package.json';
import { useState } from 'react';
import {
  PlusIcon,
  ServerIcon,
  MagnifyingGlassIcon,
  EllipsisHorizontalIcon,
  PencilSquareIcon,
  TrashIcon,
  ChevronDownIcon,
} from '@heroicons/react/16/solid';
import type { Profile } from '../model';
import type { Session } from '../state/workspace';
import { Button, IconButton } from './ui/button';
import { Menu, MenuItem, MenuSeparator } from './ui/menu';
export default function ConnectionSidebar({
  profiles,
  session,
  onOpen,
  onRemove,
  onClose,
  disabled,
}: {
  profiles: Profile[];
  session: Session | null;
  onOpen: (profile?: Profile) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
  disabled: boolean;
}) {
  const [filter, setFilter] = useState('');
  return (
    <aside className="sidebar" aria-label="Saved connections">
      <header className="sidebar-heading">
        <img className="app-icon" src={appIcon} alt="" />
        <span>Better FTP</span>
        <span className="version">{version}</span>
      </header>
      <div className="sidebar-tools">
        <Button variant="ghost" disabled={disabled} onClick={() => onOpen()}>
          <PlusIcon />
          New connection
        </Button>
        <IconButton label="Close sidebar" className="close-sidebar" onClick={onClose}>
          <ChevronDownIcon />
        </IconButton>
      </div>
      <label className="connection-filter">
        <MagnifyingGlassIcon />
        <input
          name="connection-filter"
          aria-label="Find connections"
          placeholder="Find connection"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <kbd>⌘N</kbd>
      </label>
      <div className="sidebar-label">
        Saved connections <span>{profiles.length}</span>
      </div>
      <nav aria-label="Connections" className="connection-list">
        {profiles
          .filter((p) => `${p.name} ${p.host}`.toLowerCase().includes(filter.toLowerCase()))
          .map((p) => (
            <div
              className={`connection-item ${session?.host === p.host && session.username === p.username && session.port === p.port && session.protocol === p.protocol ? 'current' : ''}`}
              key={p.id}
            >
              <button
                type="button"
                className="connection-open"
                disabled={disabled}
                onClick={() => onOpen(p)}
              >
                <ServerIcon />
                <span>
                  <strong>{p.name}</strong>
                  <small>
                    {p.username}@{p.host}
                  </small>
                </span>
                {session?.host === p.host &&
                  session.username === p.username &&
                  session.port === p.port &&
                  session.protocol === p.protocol && <span className="status-dot" />}
              </button>
              <Menu
                label={`${p.name} actions`}
                trigger={
                  <IconButton label={`${p.name} actions`}>
                    <EllipsisHorizontalIcon />
                  </IconButton>
                }
              >
                <MenuItem onSelect={() => onOpen(p)} disabled={disabled}>
                  <PencilSquareIcon />
                  Edit connection
                </MenuItem>
                <MenuSeparator />
                <MenuItem onSelect={() => onRemove(p.id)} danger>
                  <TrashIcon />
                  Remove profile
                </MenuItem>
              </Menu>
            </div>
          ))}
        {!profiles.length && <p className="sidebar-empty">No saved connections</p>}
        {profiles.length > 0 &&
          !profiles.some((p) =>
            `${p.name} ${p.host}`.toLowerCase().includes(filter.toLowerCase()),
          ) && <p className="sidebar-empty">No matching connections</p>}
      </nav>
      <footer className="sidebar-footer">
        <span>
          {profiles.length} {profiles.length === 1 ? 'connection' : 'connections'}
        </span>
        <span>FTP / FTPS / SFTP</span>
      </footer>
    </aside>
  );
}
