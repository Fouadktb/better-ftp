import { useEffect, useSyncExternalStore } from 'react';
import { client } from '../bridge';
import { createWorkspace } from './workspace';
// One controller per webview. React remounts cannot start a second transfer runner.
export const workspace = createWorkspace(client);
export function useWorkspace() {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  useEffect(() => {
    void workspace.start();
  }, []);
  return { state, workspace };
}
