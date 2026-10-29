/** The right panel's tabs. */
export type PanelTab = 'reasons' | 'unknowns' | 'node' | 'problems' | 'tests';

const PANEL_TABS: ReadonlySet<PanelTab> = new Set<PanelTab>([
  'reasons',
  'unknowns',
  'node',
  'problems',
  'tests',
]);

/** Layout preferences in localStorage: nothing that decides a result, nothing another viewer needs. */
export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  /** Panes the author closed: the scenario column, the right panel, the YAML pane. */
  collapsed: { left: boolean; right: boolean; yaml: boolean };
  /** The right panel's open tab. */
  panel: PanelTab;
  /** Whether the page's single-key shortcuts act (app/shortcuts.ts); the author can turn them off (WCAG 2.1.4). */
  keys: boolean;
  /** `simulci.prefs` is versioned so a later shape can drop an older one. */
  v: 1;
}

export const PREFS_KEY = 'simulci.prefs';

export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  collapsed: { left: false, right: false, yaml: true },
  panel: 'reasons',
  keys: true,
  v: 1,
};

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

const THEMES = new Set(['system', 'light', 'dark']);

/** Reads the preferences; anything missing, malformed or refused by the browser falls back to the defaults. */
export function readPrefs(store: StorageLike | undefined = storage()): Prefs {
  try {
    const raw = store?.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs> | null;
    if (!parsed || parsed.v !== 1) return DEFAULT_PREFS;
    return {
      v: 1,
      theme: THEMES.has(parsed.theme as string) ? (parsed.theme as Prefs['theme']) : DEFAULT_PREFS.theme,
      collapsed: {
        left: flag(parsed.collapsed?.left, DEFAULT_PREFS.collapsed.left),
        right: flag(parsed.collapsed?.right, DEFAULT_PREFS.collapsed.right),
        yaml: flag(parsed.collapsed?.yaml, DEFAULT_PREFS.collapsed.yaml),
      },
      panel: PANEL_TABS.has(parsed.panel as PanelTab) ? (parsed.panel as PanelTab) : DEFAULT_PREFS.panel,
      keys: flag(parsed.keys, DEFAULT_PREFS.keys),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

/** Writes the preferences; a refusal (quota, private window) is not an error the author can act on. */
export function writePrefs(prefs: Prefs, store: StorageLike | undefined = storage()): void {
  try {
    store?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // The page works without remembered preferences.
  }
}
