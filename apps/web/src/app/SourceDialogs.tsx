import { Suspense } from 'react';
import { OpenRepoDialog } from '../github/load';
import { PasteDialog } from './PasteDialog';
import { useApp } from './providers';

/**
 * The dialogs a way in opens, wherever its button is (the source menu, the empty state): Paste YAML, and Open GitHub
 * repository, whose view comes from the `github-*` chunk once it shows. The chunk gets the page's `openGitHub` as a prop.
 */
export function SourceDialogs({
  pasting,
  opening,
  closePaste,
  closeOpen,
}: {
  pasting: boolean;
  opening: boolean;
  closePaste: () => void;
  closeOpen: () => void;
}) {
  const { sources } = useApp();
  return (
    <>
      {pasting && <PasteDialog onClose={closePaste} />}
      {opening && (
        <Suspense fallback={null}>
          <OpenRepoDialog
            open={(target, options) => sources.openGitHub(target, options)}
            onClose={closeOpen}
          />
        </Suspense>
      )}
    </>
  );
}
