import { useRef } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import type { HostKeyInfo } from '../bridge';
import { Button } from './ui/button';
export default function HostKeyDialog({
  info,
  busy,
  error,
  onCancel,
  onTrust,
}: {
  info: HostKeyInfo;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onTrust: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const changed = info.status === 'changed';
  return (
    <AlertDialog.Root open>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay discard-overlay" />
        <AlertDialog.Content
          className="dialog-content discard-content host-key-dialog"
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            onCancel();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancel.current?.focus();
          }}
        >
          <div className="dialog-heading">
            <AlertDialog.Title>
              {changed ? 'SSH host key changed' : 'Trust this SSH host key?'}
            </AlertDialog.Title>
          </div>
          <AlertDialog.Description className="dialog-description">
            {changed
              ? 'The server is presenting a different key from the one stored on this device. The connection is blocked. Verify the change with your server administrator.'
              : 'This server is not yet trusted on this device. Verify its fingerprint with your server administrator before connecting.'}
          </AlertDialog.Description>
          <dl className="host-key-details">
            <div>
              <dt>Server</dt>
              <dd>
                {info.host}:{info.port}
              </dd>
            </div>
            <div>
              <dt>Key type</dt>
              <dd>{info.keyType}</dd>
            </div>
            <div>
              <dt>SHA256 fingerprint</dt>
              <dd className="fingerprint">{info.fingerprint}</dd>
            </div>
          </dl>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <Button ref={cancel} onClick={onCancel}>
              {busy ? 'Abort connection' : changed ? 'Close' : 'Cancel'}
            </Button>
            {!changed && (
              <Button variant="primary" disabled={busy} onClick={onTrust}>
                {busy ? 'Verifying…' : 'Trust & connect'}
              </Button>
            )}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
