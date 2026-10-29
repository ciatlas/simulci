import { Tabs } from '@base-ui/react/tabs';
import { lazy, Suspense, useMemo } from 'react';
import { useApp, useSession } from '../app/providers';
import type { PanelTab } from '../state/prefs';
import { newestOutline } from '../state/store';
import { NodeDetails } from './NodeDetails';
import { Problems } from './Problems';
import { problemRows } from './problem-rows';
import { Reasons } from './Reasons';
import { Unknowns } from './Unknowns';

/**
 * The right panel: Reasons, Unknowns (with the Assumptions above them), Node, Problems and Tests, one open at a time.
 * The open tab is a preference; `r` and `1`–`5` switch it from anywhere outside a field (app/shortcuts.ts). A tab's
 * count is what it asks the author to look at: the unknowns that decide a verdict, the problems, the cases that did
 * not pass. In edit mode the Node tab is Properties: the selection's fields, from the edit runtime, above what the plan
 * says of it.
 */

/** Properties, from the edit runtime's chunk (`edit-*`), fetched when edit mode first shows it. */
const Properties = lazy(() => import('../edit/edit').then((m) => ({ default: m.Properties })));

/** The Tests tab, a chunk of its own (`tests-*`), fetched when the tab is first shown (synthesis § 5.1). */
const Tests = lazy(() => import('./tests/tests').then((m) => ({ default: m.Tests })));

const TAB = 'rounded-t px-2.5 py-1.5 text-muted text-xs hover:text-text data-[selected]:text-text';

export function Panels() {
  const panel = useSession((s) => s.ui.prefs.panel);
  const setPanel = useSession((s) => s.setPanel);
  const plan = useSession((s) => s.plan?.plan);
  const outline = useSession(newestOutline);
  const files = useSession((s) => s.files);
  const editing = useSession((s) => s.edit.on);
  const gating = plan ? plan.unknowns.filter((u) => u.affects.length > 0).length : 0;
  const problems = useMemo(() => problemRows(outline, plan, files).length, [outline, plan, files]);
  const tests = useSession((s) => s.tests);
  const hasTests = useSession((s) => s.project.outline?.files.some((f) => f.kind === 'test') ?? false);
  const { store } = useApp();
  const summary = tests.run?.summary;
  const notPassed = summary ? summary.failed + summary.invalid : 0;

  return (
    <Tabs.Root
      value={panel}
      onValueChange={(value) => setPanel(value as PanelTab)}
      className="flex min-h-0 flex-col"
    >
      <Tabs.List aria-label="Plan details" className="flex gap-1 border-border border-b px-2 pt-1">
        <Tabs.Tab value="reasons" className={TAB}>
          Reasons
        </Tabs.Tab>
        <Tabs.Tab value="unknowns" className={TAB}>
          Unknowns
          <Count n={gating} />
        </Tabs.Tab>
        <Tabs.Tab value="node" className={TAB}>
          {editing ? 'Properties' : 'Node'}
        </Tabs.Tab>
        <Tabs.Tab value="problems" className={TAB}>
          Problems
          <Count n={problems} />
        </Tabs.Tab>
        <Tabs.Tab value="tests" className={TAB}>
          Tests
          <Count n={notPassed} />
        </Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="reasons" data-panel="reasons" className={PANEL}>
        <Reasons />
      </Tabs.Panel>
      <Tabs.Panel value="unknowns" data-panel="unknowns" className={PANEL}>
        <Unknowns />
      </Tabs.Panel>
      <Tabs.Panel value="node" data-panel="node" className={PANEL}>
        {editing ? (
          <div className="flex flex-col gap-6">
            <Suspense fallback={<p className="text-muted text-sm">loading the editor…</p>}>
              <Properties />
            </Suspense>
            <section
              aria-label="What the plan says"
              className="flex flex-col gap-2 border-border border-t pt-4"
            >
              <h2 className="font-medium text-muted text-xs uppercase tracking-wide">What the plan says</h2>
              <NodeDetails />
            </section>
          </div>
        ) : (
          <NodeDetails />
        )}
      </Tabs.Panel>
      <Tabs.Panel value="problems" data-panel="problems" className={PANEL}>
        <Problems />
      </Tabs.Panel>
      <Tabs.Panel value="tests" data-panel="tests" className={PANEL}>
        <Suspense fallback={<p className="text-muted text-sm">loading the tests…</p>}>
          <Tests tests={tests} hasTests={hasTests} actions={store.getState()} />
        </Suspense>
      </Tabs.Panel>
    </Tabs.Root>
  );
}

/**
 * The open panel scrolls, and Base UI makes it a tab stop so a panel with no control inside still scrolls by keyboard.
 * `relative` makes it the containing block of its `sr-only` text, which would otherwise escape it and scroll the page.
 */
const PANEL = 'relative min-h-0 flex-1 overflow-y-auto p-3';

function Count({ n }: { n: number }) {
  if (n === 0) return null;
  return (
    <span className="ml-1 rounded bg-chrome px-1 font-mono text-[10px] text-text tabular-nums">{n}</span>
  );
}
