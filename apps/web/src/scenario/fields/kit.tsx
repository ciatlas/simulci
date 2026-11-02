import type { ScenarioInput } from '@simulci/engine';
import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { SessionState } from '../../state/store';
import { type FieldIds, fieldAria, fieldIds } from '../aria';
import type { Chip, FormModel } from '../derive';
import type { FieldRequest } from '../focus';
import { clipOf, type NoteSide, noteSide } from '../note';

/**
 * What the field groups share: the context each reads and writes through, the frame of a field (label, control,
 * chips, hint, refusal), the assumed mark with its note, other… for a name no option holds, the switch, and the raw
 * text of the fields written one entry per line.
 */

export interface FieldContext {
  scenario: ScenarioInput;
  model: FormModel;
  /** Who set the scenario: a scenario from outside (the URL, the defaults) resets what a field keeps of its own. */
  from: SessionState['scenarioFrom'];
  /** Whether the page chose this key for the author. */
  assumed: (key: string) => boolean;
  /** The worker's refusal a field shows, by the field `deriveForm` routes it to. */
  issue: (field: string) => string | undefined;
  /** The field a pin or a reason asked the form to focus, until the form takes it: a closed group opens for it. */
  requested?: FieldRequest | undefined;
  patch: (patch: Partial<ScenarioInput>) => void;
  setScenario: (scenario: ScenarioInput) => void;
  /** Why the source cannot say which files changed, when it knows they did: a pull request past GitHub's list. */
  unlisted?: string | undefined;
}

export interface GroupProps {
  f: FieldContext;
}

export const control =
  'w-full min-w-0 rounded border border-border bg-surface px-2 py-1 text-sm text-text hover:border-border-strong aria-invalid:border-danger';
export const monoControl = `${control} font-mono`;
const labelText = 'text-muted text-xs';
const ASSUMED = 'chosen for you; change it';

/** The class that draws a value the page chose with a dashed border. */
export const marked = (on: boolean): string => (on ? ' assumed' : '');

export function useFieldIds(): FieldIds {
  return fieldIds(useId());
}

interface FieldProps {
  ids: FieldIds;
  label?: ReactNode;
  /** Beside the label and outside it, so the label alone stays the field's name. */
  tag?: ReactNode;
  hint?: string | undefined;
  issue?: string | undefined;
  children: ReactNode;
}

/**
 * A field: its label, the control and whatever follows it, then the hint and the refusal. The page's error banner
 * announces a refusal; the copy here is what the control's `aria-errormessage` and `aria-describedby` point at, so it
 * is no live region.
 */
export function Field({ ids, label, tag, hint, issue, children }: FieldProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {label !== undefined && (
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={ids.id} className={labelText}>
            {label}
          </label>
          {tag}
        </div>
      )}
      {children}
      {hint && (
        <p id={ids.hint} className="text-muted text-xs">
          {hint}
        </p>
      )}
      {issue && (
        <p id={ids.error} className="text-danger text-xs">
          {issue}
        </p>
      )}
    </div>
  );
}

/** The small tag beside a label that says a value is needed. */
export function Required() {
  return <span className="text-[11px] text-muted uppercase tracking-wide">required</span>;
}

/** Values the filters select, each a click away; the one the field holds is drawn in the accent. */
export function Chips({
  chips,
  label,
  current,
  onPick,
}: {
  chips: readonly Chip[];
  label: string;
  current?: string;
  onPick: (value: string) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <button
          key={c.value}
          type="button"
          onClick={() => onPick(c.value)}
          className={`rounded border px-1.5 py-px font-mono text-[11px] ${
            c.value === current
              ? 'border-accent bg-accent-soft text-text'
              : 'border-border text-muted hover:border-border-strong hover:text-text'
          }`}
        >
          {c.value}
          {c.value !== c.pattern && <span className="text-muted"> · {c.pattern}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * The note on a value the page chose. It is the control's description, so a screen reader hears it with the control,
 * and the dashed border says the same to the eye; the pointer resting on the control, or the focus, draws it, and
 * Escape puts it away wherever the focus is. It draws at the control's right end, clear of what sits at the left of
 * the row above (the label, or the Branch and Tag radios), above the control or below it when the scrolling column
 * would clip it there. The wrapper stays when the mark goes, so the control keeps its place in the tree (and the
 * focus) on the first edit. Drawn here, not with Base UI's Tooltip: its floating-ui positioning, about 24 kB
 * gzipped, took the page over its budget for a note with two places to go.
 */
export function Assumed({ id, on, children }: { id: string; on: boolean; children: ReactNode }) {
  const wrapper = useRef<HTMLDivElement>(null);
  const note = useRef<HTMLSpanElement>(null);
  const tip = useTip();
  const side = useSide(tip.open, wrapper, note);
  return (
    <div ref={wrapper} className="relative flex min-w-0 flex-col" {...tip.handlers}>
      {children}
      {on && (
        <span
          ref={note}
          id={id}
          role="tooltip"
          data-open={tip.open || undefined}
          data-side={tip.open ? side : undefined}
          className={tip.open ? NOTE_AT[side] : 'sr-only'}
        >
          <span className="block whitespace-nowrap rounded border border-border-strong bg-surface px-2 py-1 text-text text-xs">
            {ASSUMED}
          </span>
        </span>
      )}
    </div>
  );
}

const NOTE_AT: Record<NoteSide, string> = {
  above: 'absolute right-0 bottom-full z-10 pb-1',
  below: 'absolute top-full right-0 z-10 pt-1',
};

/** How long the pointer rests on a control before its note shows, so passing over the form draws nothing. */
const REST_MS = 250;

/**
 * Open while the pointer rests on the control or it has focus, until Escape, which the document hears, so a note
 * the pointer opened goes away with the focus elsewhere; the next rest or focus opens it again. The note sits inside
 * the wrapper with no gap, so the pointer can move onto it and it stays.
 */
function useTip() {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const open = (hovered || focused) && !dismissed;
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDismissed(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);
  const handlers = {
    onPointerEnter: () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setHovered(true);
        setDismissed(false);
      }, REST_MS);
    },
    onPointerLeave: () => {
      clearTimeout(timer.current);
      setHovered(false);
    },
    onFocus: () => {
      setFocused(true);
      setDismissed(false);
    },
    onBlur: () => setFocused(false),
  };
  return { open, handlers };
}

/** The side of the control the open note draws on, measured each time it opens. */
function useSide(
  open: boolean,
  wrapper: RefObject<HTMLElement | null>,
  note: RefObject<HTMLElement | null>,
): NoteSide {
  const [side, setSide] = useState<NoteSide>('above');
  useLayoutEffect(() => {
    if (!open || !wrapper.current || !note.current) return;
    const box = wrapper.current.getBoundingClientRect();
    setSide(noteSide(box, clipOf(wrapper.current), note.current.getBoundingClientRect().height));
  }, [open, wrapper, note]);
  return side;
}

/** The option of a select that also takes any name, which opens a box to type one in. */
export const OTHER = '…';

/**
 * Whether other… is picked: its box stays open while the text in it passes through the listed names, and a scenario
 * set from outside (the URL, the defaults) closes it.
 */
export function useOther(f: FieldContext): [boolean, (on: boolean) => void] {
  const [other, setOther] = useState(false);
  const [seen, setSeen] = useState(f.scenario);
  if (seen !== f.scenario) {
    setSeen(f.scenario);
    if (f.from !== 'author') setOther(false);
  }
  return [other, setOther];
}

interface TextFieldProps {
  f: FieldContext;
  /** The field `deriveForm` routes this key's refusal to; the control's `data-field`. */
  field: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  /** Whether the page chose the value (a pin wrote it), which the assumed mark says until an edit. */
  assumed?: boolean;
}

/** A one-line text field in the monospace face: names, refs and ids. */
export function TextField({
  f,
  field,
  label,
  value,
  onChange,
  placeholder,
  hint,
  assumed = false,
}: TextFieldProps) {
  const ids = useFieldIds();
  const issue = f.issue(field);
  return (
    <Field ids={ids} label={label} hint={hint} issue={issue}>
      <Assumed id={ids.assumed} on={assumed}>
        <input
          className={monoControl + marked(assumed)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          data-field={field}
          {...fieldAria(ids, { hint, issue, assumed })}
        />
      </Assumed>
    </Field>
  );
}

/** A switch for one fact, with the refusal its field shows. */
export function Flag({
  f,
  field,
  label,
  checked,
  onChange,
}: {
  f: FieldContext;
  field: string;
  label: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const ids = useFieldIds();
  const issue = f.issue(field);
  return (
    <Field ids={ids} issue={issue}>
      <Switch
        label={label}
        checked={checked}
        onChange={onChange}
        aria={{ ...fieldAria(ids, { issue }), 'data-field': field }}
      />
    </Field>
  );
}

interface SwitchProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  aria?: Record<string, string | boolean | undefined>;
  /**
   * Whether the page chose the value: the track's outline is dashed, as an assumed control's border is, and keeps its
   * colour, which holds the switch's 3:1 where the assumed border's would not.
   */
  assumed?: boolean;
}

/** A native checkbox with the switch role, drawn as a track; the label is its name. */
export function Switch({ label, checked, onChange, aria, assumed = false }: SwitchProps) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
        {...aria}
      />
      {/* Off: a muted outline and knob on the surface; on: the accent track, the knob moved right. Both
          outlines hold 3:1 against the form's chrome (test/contrast.test.ts); a value the page chose dashes it. */}
      <span
        aria-hidden="true"
        className={`relative h-4 w-7 shrink-0 rounded-full border border-muted bg-surface after:absolute after:top-0.5 after:left-0.5 after:size-2.5 after:rounded-full after:bg-muted peer-checked:border-accent peer-checked:bg-accent peer-checked:after:translate-x-3 peer-checked:after:bg-surface peer-focus-visible:outline-2 peer-focus-visible:outline-accent peer-focus-visible:outline-offset-1${assumed ? ' border-dashed' : ''}`}
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * The text of a field written one entry per line. The text is the author's while it spells the value, so a newline
 * or a space being typed stays; a value set from outside (the URL, a pin, a chip) replaces it.
 */
export function useRawText<T>(
  value: T,
  toText: (value: T) => string,
  same: (text: string, value: T) => boolean,
): [string, (text: string) => void] {
  const [text, setText] = useState(() => toText(value));
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    if (!same(text, value)) setText(toText(value));
  }
  return [text, setText];
}
