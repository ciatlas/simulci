import { useSyncExternalStore } from 'react';
import { gestures } from '../edit/gestures';
import { viewport } from '../graph/commands';
import { cardOf } from '../graph/navigate';
import { planIndex, resolveSelection } from '../plan/index';
import type { PanelTab } from '../state/prefs';
import { dirtyPaths, type SessionActions, type SessionState, type SessionStore } from '../state/store';
import { historyCommand, letterOf } from '../lib/history-keys';
import { callsOut } from '../lib/unit-path';
import { caseAvailability } from '../testcase/case';
import { type Pane, togglePaneKeepingFocus } from './panes';
import { canSave } from './saver';

/**
 * The page's keys outside the canvas (synthesis § 11): `t` switches between the graph and the text, `f` fits, `.`
 * centres the selection, `0` shows 100 %; `r` jumps to the Reasons tab and `1`–`5` open a tab of the right panel;
 * `[`, `]` and `\` close and open the scenario column, the right panel and the YAML pane; `c` opens Copy as test
 * case while there is a plan and a focused workflow; `e` turns edit mode on and off, and in edit mode `i` puts the
 * focus in the selected job's or step's Run if, `a` adds a job after the selected one (or to the workflow), `n` opens
 * what the selected job needs and `s` the palette for a step after the selection (synthesis § 4.2). None fires while the author
 * types (an input, a textarea, a select, an editable region such as the YAML pane), inside an open dialog, or once
 * something on the way handled the key (the canvas, a tree item: they prevent its default). None fires while the
 * author has turned them off (`prefs.keys`, the top bar's Shortcuts button; WCAG 2.1.4); the canvas's own keys need
 * the focus in the canvas and stay. Below 1024 px the text view is the only one, so `t` has nothing to switch.
 *
 * In edit mode Mod+Z undoes and Mod+Shift+Z or Mod+Y redoes the page's one edit history (synthesis § 6) wherever no
 * field keeps its own undo: whatever `prefs.keys` says, since a modifier makes them no single keys. The YAML pane
 * binds the same keys itself. Mod+Shift+D opens the Changes dialog (§ 5.2) in edit mode, the YAML pane included, and
 * Mod+K the palette, as `s` does, and F2 renames the selected job or step.
 * Mod+S saves to the folder (§ 5.3) anywhere outside a dialog, fields and the pane included; with no folder to save
 * to it opens Changes, which downloads. The page always takes it, so the browser never offers to save the page.
 */

export type PageCommand =
  | 'view'
  | 'fit'
  | 'centre'
  | 'actualSize'
  | 'reasons'
  | 'case'
  | 'edit'
  | 'runIf'
  | 'addJob'
  | 'needs'
  | 'step'
  | `panel:${PanelTab}`
  | `pane:${Pane}`;

/** What `keyFor` reads of a KeyboardEvent. */
export interface PageKey {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  isComposing?: boolean;
  target: EventTarget | null;
}

const COMMANDS = new Map<string, PageCommand>([
  ['t', 'view'],
  ['f', 'fit'],
  ['.', 'centre'],
  ['0', 'actualSize'],
  ['r', 'reasons'],
  ['c', 'case'],
  ['e', 'edit'],
  ['i', 'runIf'],
  ['a', 'addJob'],
  ['n', 'needs'],
  ['s', 'step'],
  ['1', 'panel:reasons'],
  ['2', 'panel:unknowns'],
  ['3', 'panel:node'],
  ['4', 'panel:problems'],
  ['5', 'panel:tests'],
  ['[', 'pane:left'],
  [']', 'pane:right'],
  ['\\', 'pane:yaml'],
]);

/**
 * Where an undo key is not the page's: a field or an editable region keeps its own undo until it commits, and an open
 * dialog keeps the keys. A read-only YAML pane is none of these: Mod+Z there undoes the page's last edit.
 */
const HISTORY_OWNERS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, [role="dialog"]';

/** Where a key is not the page's: form fields, editable regions, the YAML pane even read-only, an open dialog. */
const OWNERS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor, dialog, [role="dialog"]';

/** The command a key gives the page, if it is the page's to take. */
export function keyFor(event: PageKey): PageCommand | undefined {
  const command = COMMANDS.get(event.key);
  if (!command || event.defaultPrevented || held(event) || ownedElsewhere(event.target)) return undefined;
  return command;
}

/** The symbols some layouts type with Option (a German or Nordic Mac) or AltGr (Ctrl and Alt on a European PC). */
const SYMBOLS: ReadonlySet<string> = new Set(['[', ']', '\\']);

/**
 * A modifier makes it someone else's key: Ctrl+F finds, Cmd+0 resets the zoom, Alt types a character. For `[`, `]`
 * and `\` the key already is the symbol typed, so Alt, alone or with Ctrl, only says how the layout types it; Ctrl
 * alone or Cmd still makes it someone else's.
 */
function held(event: PageKey): boolean {
  if (event.metaKey || event.isComposing === true) return true;
  if (SYMBOLS.has(event.key)) return event.ctrlKey && !event.altKey;
  return event.altKey || event.ctrlKey;
}

function ownedElsewhere(target: EventTarget | null, owners = OWNERS): boolean {
  const el = target as Partial<HTMLElement> | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.isContentEditable === true || el.closest(owners) !== null;
}

/** Listens for the page keys on the window; the returned function stops. `save` saves to the folder (`app/saver.ts`). */
export function installShortcuts(
  store: SessionStore,
  win: Window = window,
  save: () => void = () => undefined,
): () => void {
  const onKey = (event: KeyboardEvent): void => {
    const s = store.getState();
    if (
      historyKey(event, s) ||
      changesKey(event, s) ||
      saveKey(event, s, save) ||
      paletteKey(event, s, store) ||
      renameKey(event, s, store)
    ) {
      event.preventDefault();
      return;
    }
    if (!s.ui.prefs.keys) return;
    const command = keyFor(event);
    if (command && run(command, s, win, store)) event.preventDefault();
  };
  win.addEventListener('keydown', onKey);
  return () => win.removeEventListener('keydown', onKey);
}

/**
 * Mod+Z, Mod+Shift+Z and Mod+Y in edit mode, where no field or editor owns the key: true when one was run, so the
 * browser's own (an input's undo, nothing at all on the page) does not run too.
 */
export function historyKey(event: HistoryKey, s: SessionState & SessionActions): boolean {
  const command =
    s.edit.on && !ownedElsewhere(event.target, HISTORY_OWNERS) ? historyCommand(event) : undefined;
  if (command === 'redo') s.redo();
  else if (command === 'undo') s.undo();
  return command !== undefined;
}

type HistoryKey = PageKey & { shiftKey?: boolean; code?: string };

/** Mod+Shift+D in edit mode, a field or the YAML pane included, outside a dialog: true when it opened Changes. */
export function changesKey(event: HistoryKey, s: SessionState & SessionActions): boolean {
  const chord = (event.metaKey || event.ctrlKey) && event.shiftKey === true && !event.altKey;
  if (!s.edit.on || !chord || event.defaultPrevented || letterOf(event) !== 'd') return false;
  const el = event.target as Partial<HTMLElement> | null;
  // An open dialog keeps its keys.
  if (typeof el?.closest === 'function' && el.closest('dialog, [role="dialog"]') !== null) return false;
  s.setChangesOpen(true);
  return true;
}

/**
 * Mod+S: true whenever it is the chord, so the browser's Save Page never opens. While no dialog is open it saves when
 * the files came from a folder with a handle, and otherwise opens Changes while something is unsaved; under an open
 * dialog (a modal keeps the focus, but a click on its text leaves it on the page's body) it does nothing more. A field
 * commits its text on the way (`edit/property/Field.tsx`); the pane's typing is in the files already.
 */
export function saveKey(event: HistoryKey, s: SessionState & SessionActions, save: () => void): boolean {
  const chord = (event.metaKey || event.ctrlKey) && event.shiftKey !== true && !event.altKey;
  if (!chord || event.defaultPrevented || letterOf(event) !== 's') return false;
  if (dialogAround(event.target)) return true;
  if (canSave(s)) save();
  else if (dirtyPaths(s.files).length > 0) s.setChangesOpen(true);
  return true;
}

/**
 * Whether a key comes from inside a dialog, or while a `<dialog>` is open anywhere on the page: the page's modals are
 * all `<dialog>`s. A popover that calls itself a dialog (Details) stays in the page while closed, so only being inside
 * one counts.
 */
function dialogAround(target: EventTarget | null): boolean {
  const el = target as (Partial<HTMLElement> & { ownerDocument?: Document | null }) | null;
  if (typeof el?.closest === 'function' && el.closest('dialog, [role="dialog"]') !== null) return true;
  const doc = el?.ownerDocument ?? (typeof document === 'undefined' ? undefined : document);
  return doc?.querySelector('dialog[open]') != null;
}

/** Mod+K in edit mode, outside a dialog: the palette, when a job or a step of the focused workflow is selected. */
function paletteKey(event: HistoryKey, s: SessionState, store: SessionStore): boolean {
  if (!s.edit.on || !modKey(event, 'k') || dialogAround(event.target)) return false;
  return Boolean(s.sel) && !callsOut(s.sel) && gestures.ask(store, (g) => g.palette());
}

/**
 * F2 in edit mode, outside fields, the YAML pane and dialogs: renames the selected job or step (synthesis § 4.2). A
 * function key, so it obeys no `prefs.keys`, which turns off the single letters only.
 */
export function renameKey(event: HistoryKey, s: SessionState, store: SessionStore): boolean {
  if (!s.edit.on || !aloneF2(event) || ownedElsewhere(event.target) || dialogAround(event.target))
    return false;
  return Boolean(s.sel) && !callsOut(s.sel) && gestures.ask(store, (g) => g.rename());
}

/** F2 with no modifier, that nothing handled yet. */
const aloneF2 = (event: HistoryKey): boolean =>
  event.key === 'F2' &&
  !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey === true || event.defaultPrevented);

/** Mod and a letter, without Shift or Alt, that nothing handled yet. */
const modKey = (event: HistoryKey, letter: string): boolean =>
  (event.metaKey || event.ctrlKey) &&
  event.shiftKey !== true &&
  !event.altKey &&
  !event.defaultPrevented &&
  letterOf(event) === letter;

/** Runs a command; false when it has nothing to act on, so the key goes on as if unheard. */
function run(
  command: PageCommand,
  s: SessionState & SessionActions,
  win: Window,
  store?: SessionStore,
): boolean {
  if (command.startsWith('panel:')) {
    const tab = command.slice('panel:'.length) as PanelTab;
    // A key pressed inside the panel would leave the focus on the tab that goes: it follows to the new one.
    const inPanel = win.document?.activeElement?.closest('[role="tabpanel"]') != null;
    showPanel(s, tab);
    if (inPanel) focusPanel(tab, win);
    return true;
  }
  if (command.startsWith('pane:')) {
    togglePaneKeepingFocus(s, command.slice('pane:'.length) as Pane, win.document);
    return true;
  }
  if (EDIT_COMMANDS.has(command)) return runEdit(command, s, store);
  if (command === 'case') {
    if (!caseAvailability(s).ok) return false;
    s.openCase();
    return true;
  }
  if (command === 'reasons') {
    showPanel(s, 'reasons');
    focusPanel('reasons', win);
    return true;
  }
  return runView(command, s, win.innerWidth);
}

const EDIT_COMMANDS: ReadonlySet<PageCommand> = new Set(['edit', 'runIf', 'addJob', 'needs', 'step']);

/**
 * `e` turns edit mode on and off. In edit mode, about the selection in the focused workflow (the workflow has no
 * `if:`, and a called workflow's job is not its file's): `i` puts the focus in Run if; `a` opens Add job, after the
 * selected job or for the workflow; `n` what the selected job needs; `s` the palette. The structural keys ask the edit
 * runtime (`edit/gestures.ts`), which takes a key pressed before it is in once it is.
 */
function runEdit(command: PageCommand, s: SessionState & SessionActions, store?: SessionStore): boolean {
  if (command === 'edit') {
    s.setEdit(!s.edit.on);
    return true;
  }
  if (!s.edit.on) return false;
  if (!store) return false;
  if (command === 'addJob') return gestures.ask(store, (g) => g.addJob());
  if (!s.sel || callsOut(s.sel)) return false;
  if (command === 'runIf') {
    s.focusProperty('if');
    return true;
  }
  return gestures.ask(store, (g) => (command === 'needs' ? g.needs() : g.palette()));
}

/**
 * Puts the focus in a right-panel tab's panel (`data-panel` in panels/Panels.tsx; Base UI owns the ids) once the
 * store's change has rendered it: after `r`, and after a button inside the panel opened another tab.
 */
export function focusPanel(tab: PanelTab, win: Window = window): void {
  win.requestAnimationFrame(() => win.document.querySelector<HTMLElement>(`[data-panel="${tab}"]`)?.focus());
}

/** Opens the right panel on a tab. */
function showPanel(s: SessionState & SessionActions, tab: PanelTab): boolean {
  if (s.ui.prefs.collapsed.right) s.togglePane('right');
  s.setPanel(tab);
  return true;
}

function runView(command: PageCommand, s: SessionState & SessionActions, width: number): boolean {
  if (command === 'view') {
    if (isNarrow(width)) return false;
    s.setView(s.ui.view === 'graph' ? 'text' : 'graph');
    return true;
  }
  if (command === 'centre') return centreSelection(s);
  if (command === 'fit') viewport.fit();
  else viewport.actualSize();
  return true;
}

/** The card that shows the selection, brought into view; nothing before the canvas has a picture. */
function centreSelection(s: SessionState): boolean {
  if (!s.plan || !s.graph) return false;
  const node = resolveSelection(planIndex(s.plan), s.focus, s.sel);
  const card = node === undefined ? undefined : cardOf(s.graph.model, node);
  if (card === undefined) return false;
  viewport.centre(card);
  return true;
}

/** Below this width the screen has no room for the canvas beside the panels: the text view is forced. */
const NARROW_BELOW = 1024;

export const isNarrow = (width: number): boolean => width < NARROW_BELOW;

/** The view the screen shows: the text below 1024 px, whatever the author picked. */
export const shownView = (view: 'graph' | 'text', narrow: boolean): 'graph' | 'text' =>
  narrow ? 'text' : view;

function onResize(change: () => void): () => void {
  window.addEventListener('resize', change);
  return () => window.removeEventListener('resize', change);
}

/** Whether the window is narrower than 1024 px, following resizes. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    onResize,
    () => isNarrow(window.innerWidth),
    () => false,
  );
}
