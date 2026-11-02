import type { NodeId } from '@simulci/engine';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { lazy, memo, type MouseEvent, Suspense, useMemo } from 'react';
import { useApp } from '../../app/providers';
import { gestures } from '../../edit/gestures';
import { cardActions, cardAttrs, resultTone, subline } from '../card';
import type { JobFlowNode } from '../flow';
import { Mark } from '../Mark';
import { gridCells, stripRows } from '../size';
import { CARD, type JobModel } from '../types';
import { HoverCard } from './HoverCard';
import { LegGrid, SkippedGrid } from './LegGrid';
import { RemoteStubView } from './RemoteStub';
import { StepList } from './StepList';
import { StepStrip } from './StepStrip';

/** The open step list of a card being edited, from the edit runtime's chunk (in by the time edit mode draws it). */
const CanvasSteps = lazy(() => import('../../edit/edit').then((m) => ({ default: m.CanvasSteps })));

/**
 * The handles sit on the header line, where `needs` edges meet a card. They are seen only on a card of the workflow
 * being edited, under the pointer, the focus or the selection, where a drag from one card's onto another's makes the
 * second need the first.
 */
const HANDLE = { top: CARD.header / 2 };

/**
 * A job card, stacked as graph/size.ts measures it: the header (mark, label, a result that is not success, the
 * step-list toggle), the subline (the verdict word and the deciding clause when it does not plainly run, `×count`,
 * the `uses:` glyph, the check), the representative leg's steps as a strip, the legs as a grid, then the open step
 * list. A skipped job keeps the strip's and the grid's room, the grid drawn as skipped cells. A call job's callee is
 * a node of its own placed below them; a remote callee the plan does not simulate is a dashed stub in its place. Runs have a solid border in the run colour, skipped ones a thin dimmed one,
 * might-run ones the only dashed border. The toggle is a tab stop only on the card that holds the selection. In edit
 * mode a card of the workflow being edited also has + on its right edge, which adds a job after it (`a` does the same),
 * and a double-click on its title renames the job (F2 does the same).
 */
function JobNodeView({ data, width }: NodeProps<JobFlowNode>) {
  const { store } = useApp();
  const act = useMemo(() => cardActions(store), [store]);
  const { job, state, editable = false } = data;
  const toggle = (e: MouseEvent): void => {
    e.stopPropagation();
    act.toggleExpanded(job.id);
  };
  const addAfter = (e: MouseEvent): void => {
    e.stopPropagation();
    act.select(job.id);
    gestures.of(store)?.addJob(job.jobId);
  };
  // A double-click on the title of a card being edited renames the job; the canvas's double-click zoom never sees it.
  const rename = (e: MouseEvent): void => {
    e.stopPropagation();
    act.select(job.id);
    gestures.of(store)?.rename();
  };
  return (
    <div className="sc-card" {...cardAttrs(job.verdict, state)} data-editable={editable || undefined}>
      <Handle type="target" position={Position.Left} isConnectable={editable} style={HANDLE} />
      <Header job={job} tabStop={state.selected} onToggle={toggle} onRename={editable ? rename : undefined} />
      <Subline job={job} />
      <Body
        job={job}
        width={width ?? CARD.minWidth}
        selected={state.inner}
        onPick={act.select}
        editable={editable}
      />
      {job.stub && <RemoteStubView job={job} stub={job.stub} tabStop={state.selected} />}
      <Handle type="source" position={Position.Right} isConnectable={editable} style={HANDLE} />
      {editable && (
        <button
          type="button"
          className="sc-add-after nodrag nopan"
          tabIndex={state.selected ? 0 : -1}
          aria-label={`Add a job after ${job.jobId}`}
          aria-keyshortcuts="A"
          title={`Add a job after ${job.jobId} (A)`}
          onClick={addAfter}
        >
          +
        </button>
      )}
      <HoverCard
        visible={state.hovered}
        facts={{
          verdict: job.verdict,
          label: job.label,
          clause: job.clause,
          check: job.check,
          result: job.result,
          needs: data.needs,
        }}
      />
    </div>
  );
}

/** The mark, the label, a result badge, and the step-list toggle (a tab stop while the card holds the selection). */
function Header({
  job,
  tabStop,
  onToggle,
  onRename,
}: {
  job: JobModel;
  tabStop: boolean;
  onToggle: (e: MouseEvent) => void;
  /** In edit mode: a double-click on the title renames the job. */
  onRename?: ((e: MouseEvent) => void) | undefined;
}) {
  return (
    <div className="sc-card-header" style={{ height: CARD.header }}>
      <Mark verdict={job.verdict} />
      <span
        className="sc-card-label"
        onDoubleClick={onRename}
        title={onRename ? `Double-click or F2 to rename ${job.jobId}` : undefined}
      >
        {job.label}
      </span>
      {job.result && (
        <span className="sc-badge font-mono" data-tone={resultTone(job.result)}>
          {job.result}
        </span>
      )}
      {(job.steps.length > 0 || job.expanded) && (
        <button
          type="button"
          className="sc-toggle nodrag"
          tabIndex={tabStop ? 0 : -1}
          aria-expanded={job.expanded}
          aria-label={job.expanded ? 'Hide the steps' : 'Show the steps'}
          onClick={onToggle}
        >
          {job.expanded ? '▾' : '▸'}
        </button>
      )}
    </div>
  );
}

function Subline({ job }: { job: JobModel }) {
  const sub = subline(job);
  return (
    <p className="sc-card-sub" style={{ height: CARD.subline }}>
      {sub.status && <span className="sc-sub-status">{sub.status}</span>}
      {sub.count && <span>{sub.count}</span>}
      {sub.uses && (
        <span title={`uses: ${sub.uses}`}>
          <span aria-hidden="true">↪</span>
          <span className="sr-only">uses {sub.uses}</span>
        </span>
      )}
      {sub.check && <span className="sc-sub-check">{sub.check}</span>}
    </p>
  );
}

/** The strip, the grid and the open list, each in the room size.ts keeps for it whether the plan fills it or not. */
function Body({
  job,
  width,
  selected,
  onPick,
  editable,
}: {
  job: JobModel;
  width: number;
  /** The selected leg or step inside the card. */
  selected?: NodeId;
  onPick: (id: NodeId) => void;
  /** Of the workflow being edited: the open list moves, removes and adds steps. */
  editable: boolean;
}) {
  const cells = gridCells(job);
  const strip =
    job.steps.length > 0 ? (
      <StepStrip steps={job.steps} width={width - 2 * CARD.padding} selected={selected} onPick={onPick} />
    ) : (
      stripRows(job) > 0 && <div className="sc-strip" style={{ height: CARD.stripRow }} />
    );
  const grid = job.legs ? (
    <LegGrid legs={job.legs} representative={job.representative} selected={selected} onPick={onPick} />
  ) : (
    cells > 0 && <SkippedGrid count={cells} />
  );
  return (
    <>
      {strip}
      {grid}
      {job.expanded &&
        (editable ? (
          <Suspense fallback={<StepList steps={job.steps} selected={selected} onPick={onPick} />}>
            <CanvasSteps job={job} selected={selected} onPick={onPick} />
          </Suspense>
        ) : (
          <StepList steps={job.steps} selected={selected} onPick={onPick} />
        ))}
    </>
  );
}

export const JobNode = memo(JobNodeView);
