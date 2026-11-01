import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { listRefsOf } from './read';
import {
  highlighted,
  isFullSha,
  moreNote,
  type Ref,
  type RefChoice,
  refChoice,
  type RefLists,
  refOptions,
  stepped,
  wholeRef,
} from './refs';
import type { Parsed } from './target';

/**
 * The ref picker of the Open GitHub repository dialog (M4 synthesis § 5.6): a field that takes a branch, a tag or a
 * commit's SHA as typed, the default branch in it once GitHub named it, and a list of the repository's branches and
 * tags that opens on its button, the arrow keys or Alt+Down. The lists are asked for the first time the list opens,
 * never before: typing a ref costs no request. It is a combobox of its own (ARIA 1.2, list autocomplete), not Base
 * UI's, whose cost the chunk need not pay.
 */

/** The lists of the repository the dialog names: not asked yet, being read, read, or why they could not be. */
export type RefsState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; lists: RefLists }
  | { state: 'failed'; message: string };

/**
 * The branches and tags of `owner/repo`, read on the first `load()` and kept for the dialog's life, so the list
 * opening again, or the same repository named again, asks nothing more. A failed read can be asked again.
 */
function useRefs(
  owner: string | undefined,
  repo: string | undefined,
): { refs: RefsState; load: () => Promise<RefLists | undefined> } {
  const name = owner === undefined || repo === undefined ? undefined : `${owner}/${repo}`.toLowerCase();
  /** Each repository's lists, by its name in lower case: naming one again shows what was read of it. */
  const [held, setHeld] = useState<Record<string, RefsState>>({});
  const asked = useRef(new Map<string, Promise<RefLists | undefined>>());
  const stop = useRef<AbortController>(undefined);
  useEffect(() => () => stop.current?.abort(), []);

  const load = useCallback((): Promise<RefLists | undefined> => {
    if (name === undefined || owner === undefined || repo === undefined) return Promise.resolve(undefined);
    const known = asked.current.get(name);
    if (known) return known;
    stop.current ??= new AbortController();
    const hold = (state: RefsState): void => setHeld((h) => ({ ...h, [name]: state }));
    hold({ state: 'loading' });
    const reading = listRefsOf({ owner, repo }, { signal: stop.current.signal }).then(
      (lists) => {
        hold({ state: 'ready', lists });
        return lists;
      },
      (e: unknown) => {
        asked.current.delete(name);
        if (!stop.current?.signal.aborted)
          hold({ state: 'failed', message: e instanceof Error ? e.message : String(e) });
        return undefined;
      },
    );
    asked.current.set(name, reading);
    return reading;
  }, [name, owner, repo]);

  return { refs: (name === undefined ? undefined : held[name]) ?? { state: 'idle' }, load };
}

/** What the author typed or picked in the field, for the repository field's text it was chosen under. */
interface Chosen {
  for: string;
  text: string;
  picked?: Ref;
}

/**
 * The ref field of the dialog, for what the repository field holds (`input`, `parsed`): the ref typed or picked, or,
 * until one is, the ref the repository field names, else the default branch once GitHub said it. A new repository
 * text forgets the choice. `resolve` is the ref Open reads: a link's path whole against the lists (read then, at
 * Open), else the field's text.
 */
export function useRefField(input: string, parsed: Parsed, defaultBranch: string | undefined) {
  const target = parsed.ok ? parsed.target : undefined;
  const { refs, load } = useRefs(target?.owner, target?.repo);
  const [held, choose] = useState<Chosen>();
  const chosen = held?.for === input ? held : undefined;
  const text = chosen?.text ?? target?.ref ?? defaultBranch ?? '';
  const lists = refs.state === 'ready' ? refs.lists : undefined;

  const resolve = async (signal: AbortSignal): Promise<RefChoice> => {
    const segments = chosen ? undefined : listedPath(parsed, defaultBranch);
    const whole = segments && (await load().then((l) => l && wholeRef(segments, l)));
    if (!whole) return refChoice(text, chosen?.picked, lists);
    if (!signal.aborted) choose({ for: input, text: whole });
    return { ok: true, ref: whole };
  };
  const onChange = (t: string, picked?: Ref): void =>
    choose({ for: input, text: t, ...(picked ? { picked } : {}) });
  return { text, picked: chosen?.picked, refs, load, onChange, resolve };
}

/**
 * A link's path that only the lists can split into a ref and a path. Not when it starts at the default branch or a
 * full SHA: git cannot hold a branch `main` and a branch `main/x` both, so the most common link costs no request.
 */
function listedPath(parsed: Parsed, defaultBranch: string | undefined): string[] | undefined {
  const segments = parsed.ok ? parsed.segments : undefined;
  const first = segments?.[0];
  return first === undefined || first === defaultBranch || isFullSha(first) ? undefined : segments;
}

export interface RefPickerProps {
  /** What the field shows: the ref typed or picked, or the one the repository field names, or its default branch. */
  value: string;
  /** The default branch, once GitHub said it: first in the list. */
  defaultBranch: string | undefined;
  refs: RefsState;
  /** The list opened: read the lists, if they are not. */
  onOpen: () => void;
  /** The ref picked, while the field still names it: its row, of a branch and a tag of one name. */
  picked: Ref | undefined;
  /** The text typed, or the ref picked from the list. */
  onChange: (text: string, picked?: Ref) => void;
  disabled?: boolean;
}

/** What the line under the field says: the lists being read, why they could not be, or that there are more. */
function noteOf(refs: RefsState, open: boolean, shown: number): string {
  if (refs.state === 'loading') return 'Reading the branches and tags…';
  if (refs.state === 'failed') return refs.message;
  if (refs.state !== 'ready') return '';
  if (open && shown === 0) return 'No branch or tag holds that: Open reads it as typed.';
  return moreNote(refs.lists) ?? '';
}

export function RefPicker({
  value,
  defaultBranch,
  refs,
  onOpen,
  picked,
  onChange,
  disabled,
}: RefPickerProps) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  /** What was typed since the list opened: the list holds what matches it; all of it before a key. */
  const [filter, setFilter] = useState<string>();
  /** The option the keys moved to; before they move, the one the field names exactly, else none. */
  const [active, setActive] = useState<number>();
  const options = open && refs.state === 'ready' ? refOptions(refs.lists, filter ?? '', defaultBranch) : [];
  const at =
    active === undefined ? highlighted(options, value, picked) : Math.min(active, options.length - 1);
  const optionId = (i: number): string => `${id}-option-${i}`;

  useEffect(() => {
    if (at >= 0) document.getElementById(optionId(at))?.scrollIntoView({ block: 'nearest' });
  });

  const show = (): void => {
    setOpen(true);
    setFilter(undefined);
    setActive(undefined);
    onOpen();
  };
  const pick = (ref: Ref): void => {
    onChange(ref.name, ref);
    setOpen(false);
  };
  const move = (by: number): void => {
    if (!open) show();
    else if (options.length) setActive(stepped(at, by, options.length));
  };
  const keys: Record<string, () => boolean> = {
    // Alt+Down too: it opens the list, as the down arrow does.
    ArrowDown: () => (move(1), true),
    ArrowUp: () => (move(-1), true),
    // An option is current only in an open list.
    Enter: () => at >= 0 && (pick(options[at]!), true),
    // A list in view closes, and the dialog stays; with none in view, Escape is the dialog's.
    Escape: () => {
      setOpen(false);
      return options.length > 0;
    },
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!keys[e.key]?.()) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const listId = `${id}-list`;
  const note = noteOf(refs, open, options.length);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={`${id}-field`}>Branch, tag or commit</label>
      <div className="flex">
        <input
          id={`${id}-field`}
          ref={field}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={at >= 0 ? optionId(at) : undefined}
          aria-describedby={`${id}-note`}
          className="min-w-0 flex-1 rounded-l border border-border bg-bg px-2 py-1 font-mono text-sm"
          value={value}
          placeholder="the default branch"
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value);
            setFilter(e.target.value);
            setActive(undefined);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label="Branches and tags"
          aria-expanded={open}
          aria-controls={listId}
          className="rounded-r border border-border border-l-0 px-2 text-muted"
          disabled={disabled}
          // The field keeps the focus, so the list's keys still work.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            field.current?.focus();
            if (open) setOpen(false);
            else show();
          }}
        >
          ▾
        </button>
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label="Branches and tags"
        hidden={!open || options.length === 0}
        className="max-h-48 overflow-auto rounded border border-border bg-bg py-1"
      >
        {options.map((r, i) => (
          <RefOption
            key={`${r.kind}:${r.name}`}
            id={optionId(i)}
            option={r}
            current={i === at}
            isDefault={r.kind === 'branch' && r.name === defaultBranch}
            onPick={pick}
          />
        ))}
      </ul>
      <p id={`${id}-note`} role="status" className="min-h-5 text-muted">
        {note}
      </p>
    </div>
  );
}

/** One row of the list: the name, and whether it is a branch, the default branch or a tag. */
function RefOption({
  id,
  option,
  current,
  isDefault,
  onPick,
}: {
  id: string;
  option: Ref;
  current: boolean;
  isDefault: boolean;
  onPick: (ref: Ref) => void;
}) {
  return (
    <li
      id={id}
      role="option"
      aria-selected={current}
      className={`flex cursor-pointer justify-between gap-2 px-2 py-0.5 ${current ? 'bg-accent text-on-accent' : ''}`}
      // The field keeps the focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(option)}
    >
      <span className="truncate font-mono">{option.name}</span>
      <span className={current ? '' : 'text-muted'}>{isDefault ? 'default branch' : option.kind}</span>
    </li>
  );
}
