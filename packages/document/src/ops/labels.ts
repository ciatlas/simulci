import { describe, fileName } from '../refusal';
import type { WorkflowOp } from './types';

/** What an op does, in the author's words: the undo history's entry. */
export function labelOf(op: WorkflowOp): string {
  return (LABELS[op.op] as (op: WorkflowOp) => string)(op);
}

type Of<K extends WorkflowOp['op']> = Extract<WorkflowOp, { op: K }>;

const setOr = (value: unknown): string => (value === null ? 'Removed' : 'Set');

const LABELS: { [K in WorkflowOp['op']]: (op: Of<K>) => string } = {
  setWorkflowField: (op) => `${setOr(op.value)} the workflow's ${op.field}`,
  addJob: (op) => `Added job ${op.id}`,
  removeJob: (op) => `Removed job ${op.job}`,
  setJobField: (op) => `${setOr(op.value)} ${op.job}'s ${op.field}`,
  setNeeds: (op) => `Set what ${op.job} needs`,
  setOutput: (op) => `${setOr(op.value)} ${op.job}'s output ${op.name}`,
  setBinding: (op) => `${setOr(op.value)} ${op.kind}.${op.name} of ${owner(op.job, op.step?.index)}`,
  addStep: (op) => `Added a step to ${op.job}`,
  removeStep: (op) => `Removed ${owner(op.job, op.index)}`,
  moveStep: (op) => `Moved ${owner(op.job, op.from)}`,
  setStepField: (op) => `${setOr(op.value)} ${op.field} of ${owner(op.job, op.index)}`,
  pinStepUses: (op) => `Pinned the action of ${owner(op.job, op.index)} to ${op.tag}'s commit`,
  setMatrixDim: (op) => `${setOr(op.values)} ${op.job}'s matrix ${op.dim}`,
  setMatrixEntry: (op) =>
    op.index === 'append'
      ? `Added an ${op.list} entry to ${op.job}'s matrix`
      : `${setOr(op.entry)} ${op.list} entry ${op.index + 1} of ${op.job}'s matrix`,
  setStrategyField: (op) => `${setOr(op.value)} ${op.job}'s ${op.field}`,
  addEvent: (op) => `Added the ${op.event} trigger`,
  removeEvent: (op) => `Removed the ${op.event} trigger`,
  setFilter: (op) => `${setOr(op.patterns)} ${op.event}'s ${op.filter}`,
  setTypes: (op) => `${setOr(op.types)} ${op.event}'s types`,
  setSchedule: (op) => (op.crons.length === 0 ? 'Removed the schedule' : 'Set the schedule'),
  setDispatchInput: (op) => `${setOr(op.input)} the input ${op.name}`,
  switchFilter: (op) => `Switched ${op.event} to ${op.to}`,
  addCase: (op) => `Added a case to ${fileName(op.file)}`,
  createFile: (op) => `Created ${fileName(op.file)}`,
  renameJob: (op) => `Renamed job ${op.job} to ${op.to}`,
  renameStepId: (op) => `Renamed the id of ${owner(op.job, op.index)} to ${op.to}`,
  dealias: (op) => `Copied into ${describe(op.path)}`,
  dealiasAnchor: (op) => `Copied \`&${op.anchor}\` into its uses`,
  convertEol: (op) => `Converted line endings to ${op.eol === '\r\n' ? 'CRLF' : 'LF'}`,
};

const owner = (job: string, index: number | undefined): string =>
  index === undefined ? job : describe(['jobs', job, 'steps', index]);
