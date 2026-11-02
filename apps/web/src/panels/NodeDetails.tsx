import type { NodeId } from '@simulci/engine';
import type { MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { useApp } from '../app/providers';
import { Mark } from '../graph/Mark';
import { MARK_LABEL } from '../lib/words';
import { type PlanIndex, selectionOf } from '../plan/index';
import { EmptyNote, SectionTitle, useSelected } from './kit';
import {
  type Fact,
  type FactSection,
  type FactValue,
  type NodeHeading,
  nodeFacts,
  nodeHeading,
  type NodeRef,
  type ValueFact,
} from './node-facts';

/** The Node tab: what the plan says of the selected node besides its reasons (synthesis § 7's Effects, in full). */
export function NodeDetails() {
  const selected = useSelected();
  if (!selected) return <EmptyNote>No plan yet.</EmptyNote>;
  const { plan, index, node } = selected;
  const heading = node === undefined ? undefined : nodeHeading(plan, index, node);
  if (node === undefined || !heading)
    return <EmptyNote>Select a workflow, job, leg or step to see what the plan says of it.</EmptyNote>;
  return (
    <div className="flex flex-col gap-4">
      <Heading heading={heading} />
      {nodeFacts(plan, index, node).map((section) => (
        <Section key={section.title} section={section} index={index} current={node} />
      ))}
    </div>
  );
}

const KIND: Record<NodeHeading['kind'], string> = {
  workflow: 'Workflow',
  job: 'Job',
  leg: 'Leg',
  step: 'Step',
  composite: 'Composite action',
};

function Heading({ heading }: { heading: NodeHeading }) {
  return (
    <header className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span aria-hidden="true">
          <Mark verdict={heading.verdict} />
        </span>
        <h2 className="min-w-0 break-words font-medium text-sm">{heading.name}</h2>
      </div>
      <p className="text-muted text-xs">
        {KIND[heading.kind]} · {MARK_LABEL[heading.verdict]}
      </p>
      <p className="break-all font-mono text-muted text-xs">{heading.path}</p>
    </header>
  );
}

function Section({ section, index, current }: { section: FactSection; index: PlanIndex; current: NodeId }) {
  return (
    <section className="flex flex-col gap-1">
      <SectionTitle>{section.title}</SectionTitle>
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {section.facts.map((fact, i) => (
          <FactRow key={`${i}:${fact.label}`} fact={fact} index={index} current={current} />
        ))}
      </dl>
    </section>
  );
}

function FactRow({ fact, index, current }: { fact: Fact; index: PlanIndex; current: NodeId }) {
  const { value } = fact;
  const elsewhere = value.kind === 'check' && value.node !== current;
  return (
    <>
      <dt className="max-w-40 break-words text-muted">
        {elsewhere ? <NodeButton node={{ id: value.node, label: fact.label }} index={index} /> : fact.label}
      </dt>
      <dd className="min-w-0 break-words font-mono">
        <FactBody value={value} index={index} />
        {fact.note !== undefined && <span className="ml-1 font-sans text-muted">({fact.note})</span>}
      </dd>
    </>
  );
}

function FactBody({ value, index }: { value: FactValue; index: PlanIndex }) {
  if (value.kind === 'text') return <span>{value.text}</span>;
  if (value.kind === 'value') return <ValueText value={value} />;
  if (value.kind === 'link')
    return (
      <a
        href={value.href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
      >
        {value.text}
        <span className="sr-only"> on GitHub (opens in a new tab)</span>
      </a>
    );
  if (value.kind === 'nodes')
    return (
      <span className="flex flex-wrap gap-x-2">
        {value.nodes.map((n) => (
          <NodeButton key={n.id} node={n} index={index} />
        ))}
      </span>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span aria-hidden="true">
        <Mark verdict={value.verdict} />
      </span>
      <span className="font-sans">{MARK_LABEL[value.verdict]}</span>
      <span aria-hidden="true" className="text-muted">
        ·
      </span>
      <ValueText value={value.result} />
    </span>
  );
}

/** A value; one a mock made known carries a chip naming it. */
function ValueText({ value }: { value: ValueFact }) {
  return (
    <span>
      {value.text}
      {value.by !== undefined && (
        <span className="ml-1 whitespace-nowrap rounded border border-border bg-chrome px-1 font-sans text-[10px] text-muted">
          by {value.by}
        </span>
      )}
    </span>
  );
}

/**
 * A button that selects a node. The tab then shows the new node's facts; when the button went with the old ones, the
 * focus waits on the tab's panel instead of falling to the page.
 */
function NodeButton({ node, index }: { node: NodeRef; index: PlanIndex }) {
  const { store } = useApp();
  const onClick = (e: MouseEvent<HTMLButtonElement>): void => {
    const button = e.currentTarget;
    const panel = button.closest<HTMLElement>('[role="tabpanel"]');
    const next = selectionOf(index, node.id);
    flushSync(() => store.getState().select(next.focus, next.sel));
    if (!button.isConnected) panel?.focus();
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Select ${node.label}`}
      className="rounded text-left font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid"
    >
      {node.label}
    </button>
  );
}
