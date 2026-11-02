import { fieldAria } from '../aria';
import { changedText, parseChanged, sameChanged } from '../form';
import { withLine } from '../lines';
import { Assumed, Chips, Field, type GroupProps, marked, monoControl, useFieldIds, useRawText } from './kit';

/**
 * The files the push or pull request changes, one per line, `path (added)` or `path (renamed from old)` for a
 * status. Always in view for the events whose `paths` the engine reads (a tag push skips them), and on any other
 * while the scenario carries some, which a model reads there (`showsChanged`): empty means unknown, and `paths`
 * filters cannot decide; a pull request GitHub lists only part of says so. Each pattern's chip adds a file it selects.
 */
export function ChangedFilesField({ f }: GroupProps) {
  const ids = useFieldIds();
  const changed = f.scenario.changed;
  const [text, setText] = useRawText<unknown>(changed, changedText, sameChanged);
  const write = (next: string): void => {
    setText(next);
    if (!sameChanged(next, changed)) f.patch({ changed: parseChanged(next) });
  };
  const hint = f.model.hints.changed;
  const note = changed === undefined ? f.unlisted : undefined;
  const issue = f.issue('changed');
  const assumed = f.assumed('changed');
  const count = Array.isArray(changed) ? changed.length : 0;
  return (
    <Field
      ids={ids}
      label={
        <>
          Changed files{' '}
          {changed === undefined ? (
            // Amber as a ground under body text: the might colour as text is under 4.5:1 on the chrome.
            <>
              · <span className="rounded-sm bg-might-soft px-1 text-text">unknown</span>
            </>
          ) : (
            <span>
              · {count} file{count === 1 ? '' : 's'}
            </span>
          )}
        </>
      }
      hint={[note, hint?.text].filter(Boolean).join(' ') || undefined}
      issue={issue}
    >
      <Assumed id={ids.assumed} on={assumed}>
        <textarea
          className={`${monoControl} min-h-24${changed === undefined ? ' border-might' : ''}${marked(assumed)}`}
          value={text}
          onChange={(e) => write(e.target.value)}
          placeholder={'src/index.ts\ndocs/readme.md (added)'}
          spellCheck={false}
          data-field="changed"
          {...fieldAria(ids, { hint: note ?? hint?.text, issue, assumed })}
        />
      </Assumed>
      <Chips
        chips={hint?.chips ?? []}
        label="Add a file the paths filters select"
        onPick={(v) => write(withLine(text, v))}
      />
    </Field>
  );
}
