import { debounce, type Timers } from '../lib/debounce';
import { type DefaultScenario, defaultBranchOf, defaultScenario } from '../scenario/defaults';
import { initialSessionState, type SessionActions, type SessionState, type SessionStore } from './store';
import { ASSUME_URL_LIMIT, readSearch, type UrlState, urlSliceChanged, urlStateOf, writeSearch } from './url';

/**
 * The URL ↔ store bridge, apart from React. Every URL the router reports that the bridge did not write itself (the
 * first one, Back, Forward, an edited address) is applied to the store, a key it leaves out going back to its
 * default. The store's URL-backed slice is written back after 300 ms of quiet: pushed when its event differs from the
 * event of the URL last written, so Back walks between events; replaced otherwise. While the scenario is the page's
 * own default, the write goes at once and always in place, so no entry is left behind for a scenario nobody chose.
 * A URL cannot hold a scenario with a blank event (the author is retyping it), so nothing is written until it names
 * one, and the URL keeps what it held.
 */

export interface UrlSyncOptions {
  store: SessionStore;
  /** Writes the search params, as a new history entry or in place of the current one. */
  navigate: (search: Record<string, unknown>, replace: boolean) => void;
  /** The search params of the URL the router holds now, which a move reaches before the route renders. */
  current: () => Record<string, unknown>;
  timers?: Timers;
  debounceMs?: number;
}

export interface UrlSync {
  /** The route renders with these search params. */
  urlChanged(search: Record<string, unknown>): void;
  /** Starts writing the store back to the URL; returns the stop. */
  start(): () => void;
}

const keyOf = (url: UrlState): string => JSON.stringify(writeSearch(url));

export function createUrlSync({
  store,
  navigate,
  current,
  timers,
  debounceMs = 300,
}: UrlSyncOptions): UrlSync {
  /** The URL the store stands for: the last one written, or the last one applied. */
  let synced: { key: string; event?: string } | undefined;
  let applying = false;

  const write = debounce(
    (state: UrlState, fromDefault: boolean) => {
      // The URL moved since the edit; the route reports the move next and the store follows it.
      if (synced === undefined || keyOf(readSearch(current())) !== synced.key) return;
      // Only what the picker keeps is written, so the URL the route renders next is the one recorded here.
      const url = readSearch(writeSearch(state));
      if (!url.scenario) return;
      const search = writeSearch(url);
      const key = JSON.stringify(search);
      if (key === synced.key) return;
      const event = url.scenario.event;
      const push = !fromDefault && synced.event !== undefined && event !== synced.event;
      synced = { key, event };
      navigate(search, !push);
    },
    debounceMs,
    timers,
  );

  return {
    urlChanged: (search) => {
      const url = readSearch(search);
      const key = keyOf(url);
      if (synced?.key === key) return;
      write.cancel();
      applying = true;
      try {
        applyUrl(store, url);
      } finally {
        applying = false;
      }
      synced = { key, event: url.scenario?.event };
    },
    start: () => {
      const unsubscribe = store.subscribe((s, prev) => {
        if (applying || !urlSliceChanged(s, prev)) return;
        const fromDefault = s.scenarioFrom === 'default';
        // The page's own default scenario is written once a project backs it; before that the URL says nothing.
        if (fromDefault && s.project.status !== 'ready') return;
        write.call(urlStateOf(s), fromDefault);
        if (fromDefault) write.flush();
      });
      return () => {
        unsubscribe();
        write.cancel();
      };
    },
  };
}

/** The page's own scenario: the default for the loaded outline, or the store's first scenario before a load. */
export function pageDefault(s: Pick<SessionState, 'project' | 'source'>): DefaultScenario {
  const outline = s.project.outline;
  return outline
    ? defaultScenario(outline, defaultBranchOf(s.source))
    : { scenario: initialSessionState().scenario, assumed: [] };
}

/** Puts back the page's own scenario and the focus that goes with it, nothing selected in it, as a load does. */
export function restoreDefault(store: SessionStore): void {
  const s = store.getState();
  const d = pageDefault(s);
  s.setScenario(d.scenario, { assumed: d.assumed, from: 'default' });
  s.select(d.focus, undefined);
}

type Session = SessionState & SessionActions;

/** Puts the store where a URL points; a key the URL leaves out goes back to its default. */
function applyUrl(store: SessionStore, url: UrlState): void {
  const s = store.getState();
  const focus = applyScenario(s, url);
  if (s.focus !== focus || s.sel !== url.sel) s.select(focus, url.sel);
  // Entries too long for the URL were never written to it, so a URL without `a` leaves them in the store.
  const assume = url.assume ?? (JSON.stringify(s.assume).length > ASSUME_URL_LIMIT ? s.assume : []);
  if (JSON.stringify(assume) !== JSON.stringify(s.assume)) s.setAssume(assume);
  applyView(s, url);
}

const sameScenario = (a: Session['scenario'], b: Session['scenario']): boolean =>
  keyOf({ scenario: a }) === keyOf({ scenario: b });

/** The URL's scenario, or the page's own when it names none; returns the focus that goes with it. */
function applyScenario(s: Session, url: UrlState): string | undefined {
  if (url.scenario) {
    if (s.scenarioFrom === 'default' || !sameScenario(s.scenario, url.scenario))
      s.setScenario(url.scenario, { from: 'url' });
    return url.wf;
  }
  const d = pageDefault(s);
  if (s.scenarioFrom !== 'default' || !sameScenario(s.scenario, d.scenario))
    s.setScenario(d.scenario, { assumed: d.assumed, from: 'default' });
  return url.wf ?? d.focus;
}

function applyView(s: Session, url: UrlState): void {
  const detail = url.d ?? 'steps';
  if (s.detail !== detail) s.setDetail(detail);
  const view = url.view ?? 'graph';
  if (s.ui.view !== view) s.setView(view);
  const hide = url.hide === true;
  if (s.ui.hideUntriggered !== hide) s.setHideUntriggered(hide);
  const edit = url.edit === true;
  if (s.edit.on !== edit) s.setEdit(edit);
}
