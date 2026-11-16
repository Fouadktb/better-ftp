import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Workspace } from './workspace';
export function useCloseGuard(workspace: Workspace) {
  const [requested, setRequested] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (workspace.busy()) {
          event.preventDefault();
          setRequested(true);
        }
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [workspace]);
  async function cancelAndClose() {
    setClosing(true);
    setError('');
    try {
      await workspace.cancelAll();
      await getCurrentWindow().destroy();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setClosing(false);
    }
  }
  return { requested, closing, error, keepOpen: () => setRequested(false), cancelAndClose };
}
