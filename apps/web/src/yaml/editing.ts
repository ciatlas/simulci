import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { EditorState, type Extension, type Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { historyCommand } from '../lib/history-keys';
import type { Alone } from '../state/history';
import { fromStore } from './extensions';

/**
 * What makes a file's state writable in edit mode (synthesis § 4.3): CodeMirror's editing keys without its history,
 * whose undo is the page's one history in the store; the file's indent; and the listener that hands each change the
 * author makes to the store. A change that came from the store (`fromStore`) is never handed back. The browser's own
 * undo (`beforeinput` historyUndo and historyRedo, from the Edit menu or a gesture) goes to the store too, and a key
 * typed over a selection is applied here, not by the browser.
 */

export interface EditHandlers {
  /** A change the author made, as CodeMirror has it; the pane maps it to the store's offsets. */
  changed: (tr: Transaction) => void;
  /** After the changes of one update went to the store: the pane checks the view still shows the store's text. */
  forwarded: (view: EditorView) => void;
  undo: () => boolean;
  redo: () => boolean;
  /** The editor lost the focus: the typing group closes. */
  blurred: () => void;
}

/** The indent a file uses: the leading spaces of its first indented line, else two. */
export function indentOf(text: string): number {
  const n = /^( +)[^\s#]/m.exec(text)?.[1]?.length ?? 2;
  return n <= 8 ? n : 2;
}

/** What the store's history calls a change that is no key: a paste, a cut, a drop. */
export function aloneOf(tr: Transaction): Alone | undefined {
  if (tr.isUserEvent('input.paste')) return 'paste';
  if (tr.isUserEvent('delete.cut')) return 'cut';
  if (tr.isUserEvent('input.drop') || tr.isUserEvent('move.drop')) return 'drop';
  return undefined;
}

/**
 * A key typed over a selection, made a transaction here instead of by the browser. Chrome keeps the look of the text it
 * deletes for the text typed in its place, as a `style` attribute on the new line (a bold key's `font-weight`), which
 * the CSP (`style-src 'self'`) refuses with a console error before CodeMirror rereads the line. A key typed at a cursor
 * deletes nothing, and composition goes on through the browser, so both are left to it. The input handlers run as
 * they would for the browser's change.
 */
function typedOverSelection(event: InputEvent, view: EditorView): boolean {
  const text = event.data;
  if (text === null || event.isComposing || view.composing || view.state.selection.main.empty) return false;
  event.preventDefault();
  const { from, to } = view.state.selection.main;
  const insert = (): Transaction =>
    view.state.update(view.state.replaceSelection(text), { userEvent: 'input.type', scrollIntoView: true });
  if (!view.state.facet(EditorView.inputHandler).some((handler) => handler(view, from, to, text, insert))) {
    view.dispatch(insert());
  }
  return true;
}

/**
 * The extensions of a writable file: editable, keyed, indented, and listened to. Its content is a tab stop by its
 * attribute, as a read-only file's is: the browser tabs into an editing host anyway, but axe counts the scroller as
 * reachable by the keyboard only through a `tabindex`.
 */
export function writableExtensions(path: string, indent: number, on: EditHandlers): Extension[] {
  return [
    EditorState.readOnly.of(false),
    EditorView.editable.of(true),
    EditorView.contentAttributes.of({ 'aria-label': path, tabindex: '0' }),
    indentUnit.of(' '.repeat(indent)),
    keymap.of([...defaultKeymap, indentWithTab]),
    EditorView.domEventHandlers({
      // Before the keymap, which would take Mod+Shift+Z reported as a lowercase `z` for Mod+Z. Taken whether or not
      // there is anything to undo: the browser's own undo has nothing to do here.
      keydown: (event) => {
        const command = historyCommand(event);
        if (!command) return false;
        event.preventDefault();
        if (command === 'redo') on.redo();
        else on.undo();
        return true;
      },
      beforeinput: (event, view) => {
        if (event.inputType === 'insertText') return typedOverSelection(event, view);
        if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return false;
        event.preventDefault();
        if (event.inputType === 'historyUndo') on.undo();
        else on.redo();
        return true;
      },
      blur: () => {
        on.blurred();
        return false;
      },
    }),
    EditorView.updateListener.of((update) => {
      const authored = update.transactions.filter((tr) => tr.docChanged && !tr.annotation(fromStore));
      for (const tr of authored) on.changed(tr);
      if (authored.length > 0) on.forwarded(update.view);
    }),
  ];
}
