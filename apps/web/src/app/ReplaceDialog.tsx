import { useCallback } from 'react';
import { patchName } from '../lib/repo-words';
import type { Replacing } from '../state/store';
import { useModal } from './modal';
import { useApp, useSession } from './providers';
import { canSave } from './saver';

const button = 'rounded border border-border px-3 py-1.5 text-sm hover:border-border-strong';
const primary = 'rounded bg-accent px-3 py-1.5 text-on-accent text-sm';

/**
 * Asks before files with unsaved edits give way to another source (synthesis § 5.7): Save them to the folder they
 * came from, the main answer whenever the files can be saved, then go on once every one is saved; Download the edited
 * files, each or as one patch, then go on; Discard the edits; or Cancel, which keeps everything as it is. Escape is
 * Cancel. Without a folder to save to, and with several files, the patch is the main answer: one download, where a
 * browser may hold the second and later of several behind a "Download multiple files?" question while the files are
 * already gone.
 */
export function ReplacePrompt() {
  const replacing = useSession((s) => s.replacing);
  // A dialog per question, so each opens as a modal when it mounts.
  return replacing ? <ReplaceDialog key={replacing.seq} replacing={replacing} /> : null;
}

function ReplaceDialog({ replacing: { what, paths } }: { replacing: Replacing }) {
  const { prompt } = useApp();
  const names = paths.map(baseName).join(', ');
  const count = paths.length;
  const several = count > 1;
  const saves = useSession((s) => canSave(s));
  const folder = useSession((s) => (s.source.kind === 'folder' ? s.source.name : ''));
  const patch = useSession((s) => patchName(s.source));
  const cancel = useCallback(() => prompt.answer('cancel'), [prompt]);
  const dialog = useModal(cancel);
  return (
    <dialog
      ref={dialog}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-0 text-text backdrop:bg-black/40"
      aria-labelledby="replace-title"
      aria-describedby="replace-body"
    >
      <div className="flex flex-col gap-3 p-4">
        <h2 id="replace-title" className="font-semibold">
          Unsaved edits
        </h2>
        <p id="replace-body" className="text-sm">
          {several ? `${names} have unsaved edits.` : `${names} has unsaved edits.`} {what} drops them.
          {saves && ` Save writes them to ${folder} first.`}
          {several && ` Download patch saves every edit as one file, ${patch}, for git apply.`}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={button} onClick={cancel}>
            Cancel
          </button>
          <button type="button" className={button} onClick={() => prompt.answer('discard')}>
            Discard edits
          </button>
          {several && !saves && (
            <button type="button" className={button} onClick={() => prompt.answer('download')}>
              Download each file
            </button>
          )}
          <button
            type="button"
            className={several && !saves ? primary : button}
            onClick={() => prompt.answer('patch')}
          >
            Download patch
          </button>
          {!several && !saves && (
            <button type="button" className={primary} onClick={() => prompt.answer('download')}>
              Download it first
            </button>
          )}
          {saves && (
            <button type="button" className={primary} onClick={() => prompt.answer('save')}>
              Save
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
