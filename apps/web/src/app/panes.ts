import type { Prefs } from '../state/prefs';
import type { SessionActions, SessionState } from '../state/store';

/** A pane the author opens and closes: the scenario column, the right panel, the YAML pane. */
export type Pane = keyof Prefs['collapsed'];

/** Where the keyboard stops inside a pane: a field, a button, a link, the open tab (the others are -1). */
const TABBABLE =
  ':is(button, input, select, textarea, [href], [tabindex]):not([disabled], [tabindex="-1"], [type="hidden"])';

/**
 * Opens or closes a pane (`data-pane` in app/SimulateView.tsx). A pane that closes with the focus inside it first
 * hands the focus to the plan (`data-plan`), so the focus never drops to the page's body. A pane opened from its rail
 * (`data-rail`, which goes as the pane comes), by a click or a key, takes the focus on its first stop once drawn.
 */
export function togglePaneKeepingFocus(
  s: Pick<SessionState, 'ui'> & Pick<SessionActions, 'togglePane'>,
  pane: Pane,
  doc: Document = document,
): void {
  const open = !s.ui.prefs.collapsed[pane];
  const active = doc.activeElement;
  if (open && doc.querySelector(`[data-pane="${pane}"]`)?.contains(active)) {
    doc.querySelector<HTMLElement>('[data-plan]')?.focus();
  }
  s.togglePane(pane);
  if (!open && doc.querySelector(`[data-rail="${pane}"]`)?.contains(active)) {
    doc.defaultView?.requestAnimationFrame(() => focusPane(pane, doc));
  }
}

/** Puts the focus on a pane's first stop, or on the plan when the pane has none to give. */
function focusPane(pane: Pane, doc: Document): void {
  const into = doc.querySelector(`[data-pane="${pane}"]`)?.querySelector<HTMLElement>(TABBABLE);
  (into ?? doc.querySelector<HTMLElement>('[data-plan]'))?.focus();
}
