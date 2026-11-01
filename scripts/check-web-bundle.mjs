#!/usr/bin/env node
/**
 * The browser bundle's contract, checked from the source maps and stylesheets of `apps/web/dist`:
 * - the engine (and with it @ciatlas/core, zod, @actions/*, picomatch) lives only in the engine worker chunk;
 * - yaml lives only in the engine worker and the edit runtime, and the document model, but for its text edits, only in
 *   the edit runtime;
 * - the engine worker chunk is built from core's browser entry (no node-fs, no git);
 * - elkjs lives only in the layout worker chunk, which holds none of the engine;
 * - the bundled action catalog is a chunk of its own, holding the catalog alone;
 * - no chunk imports a Node built-in or holds the Node host (packages/node);
 * - no stylesheet inlines a font, which the CSP's font-src 'self' would refuse;
 * - every chunk has a gzip budget and stays under it.
 * The rules are scripts/web-bundle-rules.mjs. Usage: node scripts/check-web-bundle.mjs [apps/web/dist]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chunkProblems, stylesheetProblems } from './web-bundle-rules.mjs';

const dist = process.argv[2] ?? 'apps/web/dist';
const assets = join(dist, 'assets');

/**
 * Gzip budgets in kB, 15 % above the figures measured when the budget was set (the right panel and the YAML pane
 * over the run graph), rounded up; raise them on purpose.
 */
const BUDGETS = [
  // The engine, @ciatlas/core, yaml, zod and @actions/*: 149.4 kB measured; 164.9 with the route tests' runner and
  // its assertions (156.5 before, synthesis § 5.11); 169.4 with remote workflows and actions planned, 170.6 with the
  // remotes taken level by level from the page's pool (M4 § 5.3), and the budget stays 172.
  { name: 'the engine worker', test: (f) => f.startsWith('engine.worker-'), kB: 172 },
  // elkjs: 428.5 kB measured.
  { name: 'the layout worker', test: (f) => f.startsWith('layout.worker-'), kB: 493 },
  // React, the router, React Flow and its d3 modules, Base UI, the scenario form, the panels and the edit history,
  // with the crash snapshot, the replace prompt, edit mode, what an edit changed (the plan diff and Details, a
  // platform popover), the edit runtime's and the dialogs' loaders, Save's buttons and keys with its permission
  // request, the canvas's side of its gestures, a rename's remaps, the Tests tab's state, schedule and loader, and a
  // GitHub source's state, words, loader, menu entry, card and link offer, and the remotes' state, reads and chip:
  // 246.7 kB measured (245.6 before the remotes, 244.0 before the dialog's entries, 242.2 before the GitHub source,
  // 241.2 before the Tests tab, 246.5 before the dialogs moved to their own chunk). The synthesis keeps 251 (§ 8.5,
  // M4 § 5.11).
  { name: 'the page', test: (f) => f.startsWith('index-') && f.endsWith('.js'), kB: 251 },
  // CodeMirror's view, state, language and commands with the YAML grammar, and the pane's edit mode, fetched when the
  // pane first opens: 107.1 kB measured (95.4 before edit mode).
  { name: 'the YAML pane', test: (f) => f.startsWith('YamlPane-'), kB: 124 },
  // The edit runtime: yaml with its composer, the document model, the op dispatch, Properties, the matrix editor, the
  // canvas's gestures (Add job, What it needs, the palette, the step lists; platform popovers and a combobox of our
  // own, not Base UI's, which would add 33 kB), the triggers editor, the catalog's loader and Pin to SHA, a test case
  // added to its file, and renames, fetched for editing: 91.6 kB measured (78.9 before the triggers editor); the budget
  // stays 98.
  { name: 'the edit runtime', test: (f) => f.startsWith('edit-'), kB: 98 },
  // The Changes, save and test case dialogs with the restore conflicts' rows, the line diff and the patch, and what
  // Save and Reload run against the folder, fetched on idle once a file is unsaved (synthesis § 8.5): 9.9 kB measured.
  { name: 'the dialogs', test: (f) => f.startsWith('dialogs-'), kB: 12 },
  // The Tests tab: the route tests' results grouped by file, with their actions, fetched when the tab is first shown
  // (M4 synthesis § 5.1): 1.9 kB measured; the synthesis budgets 8 (§ 5.11).
  { name: 'the Tests tab', test: (f) => f.startsWith('tests-'), kB: 8 },
  // The GitHub source: core's remote fetcher (its client, retries and failure kinds), the repository reader, the
  // revalidating fetch, the IndexedDB content cache, the Open GitHub repository dialog and the remotes' reader,
  // fetched when a repository is first opened or fetched again, or remotes are first read (M4 synthesis § 5.3, § 5.5):
  // 8.2 kB measured (6.9 before the remotes, 5.8 before the dialog); the synthesis budgets 16 (§ 5.11) for the ref
  // picker too.
  { name: 'the GitHub source', test: (f) => f.startsWith('github-'), kB: 16 },
  // The bundled action catalog, 50 actions with their refs, commits and inputs, fetched by the edit runtime when the
  // palette or Properties needs it (synthesis § 4.8): 33.0 kB measured.
  { name: 'the action catalog', test: (f) => f.startsWith('catalog-'), kB: 38 },
];

const problems = [];
const assetFiles = readdirSync(assets);
const files = assetFiles.filter((f) => f.endsWith('.js'));
if (files.length === 0) problems.push(`no JavaScript chunk under ${assets}`);

const rows = [];
for (const file of files) {
  const code = readFileSync(join(assets, file), 'utf8');
  const gz = gzipSync(code).length / 1024;
  let sources = [];
  try {
    sources = JSON.parse(readFileSync(join(assets, `${file}.map`), 'utf8')).sources ?? [];
  } catch {
    problems.push(`${file} has no source map to check`);
  }
  problems.push(...chunkProblems(file, sources));
  const byPackage = new Map();
  for (const s of sources) {
    const m = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(s);
    const key = m
      ? m[1]
      : s.includes('packages/')
        ? s.replace(/.*packages\/([^/]+).*/, '@simulci/$1')
        : 'app';
    byPackage.set(key, (byPackage.get(key) ?? 0) + 1);
  }
  rows.push({ file, kB: statSync(join(assets, file)).size / 1024, gz, packages: byPackage });
  const budget = BUDGETS.find((b) => b.test(file));
  if (!budget) problems.push(`${file} has no gzip budget: measure it and add one to BUDGETS`);
  else if (gz > budget.kB)
    problems.push(`${file} is ${gz.toFixed(1)} kB gzipped; the budget for ${budget.name} is ${budget.kB} kB`);
}

for (const file of assetFiles.filter((f) => f.endsWith('.css')))
  problems.push(...stylesheetProblems(file, readFileSync(join(assets, file), 'utf8')));

const table = ['| chunk | kB | gzip kB | sources |', '|---|---:|---:|---|'];
for (const r of rows) {
  const top = [...r.packages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  table.push(
    `| ${r.file} | ${r.kB.toFixed(0)} | ${r.gz.toFixed(1)} | ${top.map(([k, n]) => `${k} (${n})`).join(', ')} |`,
  );
}
const report = table.join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Browser bundle\n\n${report}\n`);
}
if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log('the browser bundle keeps its contract');
