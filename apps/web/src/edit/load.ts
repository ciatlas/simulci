import { fetchOnce, type Idle, onIdle } from '../lib/lazy';
import type { SessionState, SessionStore } from '../state/store';

/** The sources whose plans are likely edited: a sample's is mostly looked at. */
const EDITED_KINDS: ReadonlySet<string> = new Set(['folder', 'github', 'paste']);

/** The edit runtime (`edit/edit.ts`, the `edit-*` chunk) fetched ahead of need. */
const loadEdit = fetchOnce(() => import('./edit'));

/**
 * Fetches the runtime before the author needs it (synthesis § 4.1): at once on entering edit mode, and on idle once
 * a plan of a folder, a GitHub repository or pasted files is on screen, where editing is likely. A sample's plan fetches nothing: most
 * visits only look. Returns the unsubscribe, which the fetch also calls.
 */
export function installEditPrefetch(
  store: SessionStore,
  { idle = onIdle, load = loadEdit }: { idle?: Idle; load?: () => Promise<unknown> } = {},
): () => void {
  let unsubscribe: () => void = () => undefined;
  const fetch = (when: 'now' | 'idle'): void => {
    unsubscribe();
    const go = (): void => void load().catch(() => undefined);
    if (when === 'now') go();
    else idle(go);
  };
  const check = (s: SessionState): boolean => {
    if (s.edit.on) fetch('now');
    else if (s.plan && EDITED_KINDS.has(s.source.kind)) fetch('idle');
    else return false;
    return true;
  };
  if (!check(store.getState())) unsubscribe = store.subscribe(check);
  return () => unsubscribe();
}
