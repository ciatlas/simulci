import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActorSchema,
  AssumeEntrySchema,
  AssumeListSchema,
  BECAUSE,
  CaseSchema,
  ChangeStatusSchema,
  parseScenario,
  parseUnitPath,
  ScenarioInputSchema,
  schemaUrl,
  SHIPPED_MODELS,
  TestFileSchema,
  ThenSchema,
  UnitAssertionSchema,
  WorkflowRunSchema,
} from '@simulci/engine';
import { parseAssume } from '@simulci/node';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderModels } from '../../../packages/cli/src/models';
import { planArgs, planCommand, planOutput } from '../../../packages/cli/src/plan';
import { remotesCommand } from '../../../packages/cli/src/remotes';
import { runTestCommand, type TestIo, testCommand } from '../../../packages/cli/src/test';
import { APP_URL } from '../lib/site';

/**
 * The docs against the source: the flags they name are the commands' flags, their tables list the schemas' keys and
 * action.yml's inputs, their codes are the codes the engine reports, and their examples print what the page shows.
 */

const root = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const page = (name: string): string => read(`apps/docs/content/docs/${name}.mdx`);

/** The rows of the first table after a heading, as cells with their backticks removed. */
function table(mdx: string, heading: string): string[][] {
  const start = mdx.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`no heading '${heading}'`);
  const rows = mdx
    .slice(start + heading.length + 2)
    .split('\n## ')[0]!
    .split('\n### ')[0]!
    .split('\n');
  return rows
    .filter((l) => l.startsWith('| `'))
    .map((l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim().replace(/^`([^`]*)`$/, '$1')),
    );
}

const keys = (mdx: string, heading: string): string[] => table(mdx, heading).map((r) => r[0]!);
const sorted = (list: Iterable<string>): string[] => [...list].sort();

/** The fenced blocks of a page, in order, with their language. */
function blocks(mdx: string): { lang: string; text: string }[] {
  return [...mdx.matchAll(/^```(\w+)[^\n]*\n([\s\S]*?)^```$/gm)].map((m) => ({ lang: m[1]!, text: m[2]! }));
}

type Args = Record<string, { type?: string; alias?: string | string[] }>;

/** The flags of a command, as its keys spell them: in kebab case, as `--help` shows them. */
function commandFlags(args: Args): string[] {
  return Object.entries(args)
    .filter(([, a]) => a.type !== 'positional')
    .map(([name]) => `--${name}`);
}

const docFlags = (mdx: string): Set<string> => new Set(mdx.match(/(?<![\w-])--[a-z][a-z-]*/g));

describe('the CLI pages', () => {
  const plan = commandFlags(planCommand.args as Args);
  const test = commandFlags(testCommand.args as Args);
  const subCommands = remotesCommand.subCommands as Record<string, { args: Args }>;
  const remotes = Object.values(subCommands).flatMap((c) => commandFlags(c.args));

  it('name every flag of simulci plan, and no other', () => {
    expect(sorted(docFlags(page('cli/plan')))).toEqual(sorted(plan));
  });

  it('name every flag of simulci test, and its short forms', () => {
    const mdx = page('cli/test');
    expect(sorted(docFlags(mdx))).toEqual(sorted(test));
    for (const a of Object.values(testCommand.args as Args))
      for (const alias of [a.alias ?? []].flat()) expect(mdx).toContain(`\`-${alias}\``);
  });

  it('name every flag of simulci remotes, with the subcommands that take it', () => {
    const mdx = page('cli/remotes');
    const rows = table(mdx, '## Flags');
    expect(sorted(rows.map((r) => r[0]!))).toEqual(sorted(new Set(remotes)));
    expect(Object.keys(subCommands)).toEqual(['update', 'check']);
    for (const [flag, , command] of rows) {
      const takes = Object.entries(subCommands)
        .filter(([, c]) => commandFlags(c.args).includes(flag!))
        .map(([name]) => name);
      expect(command, flag).toBe(takes.length === 2 ? 'both' : takes.join(', '));
    }
  });

  it('name no flag the commands lack anywhere', () => {
    const known = new Set([...plan, ...test, ...remotes, '--save-dev']);
    const pages = readdirSync(new URL('apps/docs/content/docs', root), { recursive: true, encoding: 'utf8' });
    for (const file of pages.filter((f) => f.endsWith('.mdx')))
      for (const flag of docFlags(page(file.replace(/\.mdx$/, ''))))
        expect(known, `${file}: ${flag}`).toContain(flag);
  });

  it('give --assume examples simulci reads', () => {
    const examples = [...page('cli/plan').matchAll(/^--assume ('[^']+'|\S+)/gm)].map((m) =>
      m[1]!.replace(/^'|'$/g, ''),
    );
    expect(examples.length).toBeGreaterThan(3);
    for (const example of examples) expect(() => parseAssume([example]), example).not.toThrow();
  });
});

describe('the reference pages', () => {
  it('list the keys of a test file, a case, then and a unit assertion', () => {
    const mdx = page('reference/test-files');
    expect(sorted(keys(mdx, '## The file'))).toEqual(sorted(Object.keys(TestFileSchema.shape)));
    expect(sorted(keys(mdx, '## A case'))).toEqual(sorted(Object.keys(CaseSchema.shape)));
    expect(sorted(keys(mdx, '## then'))).toEqual(sorted(Object.keys(ThenSchema.shape)));
    expect(sorted(keys(mdx, '### units'))).toEqual(sorted(Object.keys(UnitAssertionSchema.shape)));
  });

  it('list every reason a because: names', () => {
    const section = page('reference/test-files').split('### because')[1]!.split('\n### ')[0]!;
    const named = [...section.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]!);
    expect(sorted(new Set(named))).toEqual(sorted(BECAUSE));
  });

  it('give unit paths that parse, and examples that are test files', () => {
    const mdx = page('reference/test-files');
    for (const path of keys(mdx, '## Unit paths')) expect(() => parseUnitPath(path), path).not.toThrow();
    const yaml = blocks(mdx).filter((b) => b.lang === 'yaml');
    expect(TestFileSchema.safeParse(parse(yaml[0]!.text)).success).toBe(true);
    expect(ThenSchema.safeParse((parse(yaml[1]!.text) as { then: unknown }).then).success).toBe(true);
  });

  it('list the scenario fields, and give scenarios that parse', () => {
    const mdx = page('reference/scenarios');
    expect(sorted(keys(mdx, '## Fields'))).toEqual(sorted(Object.keys(ScenarioInputSchema.shape)));
    const rows = new Map(table(mdx, '## Fields').map((r) => [r[0]!, r[1]!]));
    for (const k of Object.keys(ActorSchema.shape)) expect(rows.get('actor')).toContain(k);
    for (const k of Object.keys(WorkflowRunSchema.shape)) expect(rows.get('workflow_run')).toContain(k);
    for (const s of ChangeStatusSchema.options) expect(rows.get('changed')).toContain(`\`${s}\``);
    for (const line of blocks(mdx)[0]!.text.trim().split('\n'))
      expect(() => parseScenario((parse(line) as { when: unknown }).when), line).not.toThrow();
  });

  it('list the keys of an assume entry, the shipped models and the mock codes', () => {
    const mdx = page('reference/mocks');
    expect(sorted(keys(mdx, '## An entry'))).toEqual(sorted(Object.keys(AssumeEntrySchema.shape)));
    expect(
      AssumeListSchema.safeParse((parse(blocks(mdx)[0]!.text) as { assume: unknown }).assume).success,
    ).toBe(true);
    expect(mdx).toContain(`\`\`\`text\n${renderModels(SHIPPED_MODELS, 'text')}\n\`\`\``);
    expect(sorted(keys(mdx, '## Diagnostics'))).toEqual(
      sorted(codesIn('packages/engine/src', /\bSC1\d\d\b/g)),
    );
  });

  it('list every test error code the hosts report', () => {
    const hosts = ['engine', 'node', 'cli', 'action'].flatMap((p) =>
      codesIn(`packages/${p}/src`, /\bT[0-2]\d\d\b/g),
    );
    expect(sorted(keys(page('reference/test-files'), '## Error codes'))).toEqual(sorted(new Set(hosts)));
  });

  it('link the JSON schemas where they are published', () => {
    expect(page('reference/test-files')).toContain(`(${schemaUrl('test')})`);
    expect(page('reference/scenarios')).toContain(`(${schemaUrl('scenario')})`);
  });
});

/** The codes a package's sources mention. */
function codesIn(dir: string, pattern: RegExp): string[] {
  const files = readdirSync(new URL(dir, root), { recursive: true, encoding: 'utf8' }).filter((f) =>
    f.endsWith('.ts'),
  );
  return [...new Set(files.flatMap((f) => read(`${dir}/${f}`).match(pattern) ?? []))];
}

describe('the web app', () => {
  it('is linked where it is served', () => {
    expect(page('web-app')).toContain(`(${APP_URL})`);
    expect(page('index')).toContain(`(${APP_URL})`);
  });
});

describe('the Action page', () => {
  const action = parse(read('action.yml')) as {
    inputs: Record<string, { default?: string }>;
    outputs: Record<string, unknown>;
  };

  it('lists every input with its default, and every output', () => {
    const inputs = table(page('action'), '## Inputs');
    expect(inputs.map((r) => r[0])).toEqual(Object.keys(action.inputs));
    for (const [name, value] of inputs) expect(value, name).toBe(action.inputs[name!]!.default ?? '');
    expect(keys(page('action'), '## Outputs')).toEqual(Object.keys(action.outputs));
  });

  it('uses the release the repository is at', () => {
    const { version } = JSON.parse(read('package.json')) as { version: string };
    const refs = page('action').match(/ciatlas\/simulci@\S+/g);
    expect(refs).toEqual([`ciatlas/simulci@v${version}`, `ciatlas/simulci@v${version}`]);
  });
});

describe('the getting-started example', () => {
  /** No network and no `gh`: the example has no remote to read. */
  const io = (out: { text: string }): TestIo => ({
    stdout: (t) => (out.text += t),
    stderr: (t) => (out.text += t),
    env: {},
    fetch: () => Promise.reject(new Error('no network')),
    gh: () => undefined,
  });
  const mdx = page('index');
  const all = blocks(mdx);
  const dir = mkdtempSync(join(tmpdir(), 'simulci-docs-'));
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  mkdirSync(join(dir, '.github/simulci/tests'), { recursive: true });
  writeFileSync(join(dir, '.github/workflows/ci.yml'), all.find((b) => b.lang === 'yaml')!.text);

  it('prints the plans the page shows', async () => {
    const runs = all.flatMap((b, i) => {
      const command = /^npx simulci plan (.*)$/.exec(b.text.trim());
      return command ? [{ args: command[1]!, shown: all[i + 1]!.text }] : [];
    });
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      const out = await planOutput(planArgs(['--dir', dir, ...run.args.split(' ')]), io({ text: '' }));
      expect(out.text, run.args).toBe(run.shown);
    }
  });

  it('passes the test the page writes, as the page shows', async () => {
    const test = all.find((b) => b.text.startsWith('workflow: ci.yml'))!;
    writeFileSync(join(dir, '.github/simulci/tests/ci.test.yml'), test.text);
    const out = { text: '' };
    expect(await runTestCommand({ dir }, io(out))).toBe(0);
    expect(out.text).toBe(all[all.indexOf(test) + 2]!.text);
  });

  it('fails the way the page shows when the first case also expects deploy', async () => {
    const test = all.find((b) => b.text.startsWith('workflow: ci.yml'))!;
    expect(mdx).toContain('Had the first case said `run: [test, deploy]`');
    writeFileSync(
      join(dir, '.github/simulci/tests/ci.test.yml'),
      test.text.replace('run: [test]', 'run: [test, deploy]'),
    );
    const out = { text: '' };
    expect(await runTestCommand({ dir }, io(out))).toBe(1);
    expect(out.text).toContain(all.at(-1)!.text);
  });
});
