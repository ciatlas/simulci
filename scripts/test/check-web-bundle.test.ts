/**
 * The browser bundle's contract (scripts/check-web-bundle.mjs): its rules on small inputs, then on what the web app's
 * own Vite config builds, so a rule that cannot match Vite's output fails here instead of passing quietly in CI. The
 * built token sheet is checked too: like the fonts, its first paint is what the browser gets before any script runs,
 * and applyTheme is what takes over once one does. The built layout worker is run as well, in a global scope shaped
 * like a worker's, which is where ELK's bundle behaves differently from a page or Node.
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyTheme } from '../../apps/web/src/app/theme';
import type { LayoutRequest, LayoutResponse } from '../../apps/web/src/worker/layout-protocol';
import { chunkProblems, stylesheetProblems } from '../web-bundle-rules.mjs';

const root = join(import.meta.dirname, '../..');
const web = join(root, 'apps/web');

/** What the app's chunks list today, as their source maps spell it. */
const PAGE = [
  '../../src/main.tsx',
  '../../../../packages/engine/src/plan/index.ts',
  '../../../../node_modules/.pnpm/react@19.3.1/node_modules/react/index.js',
];
const ZOD = '../../../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/index.js';
const WORKER = [
  '../../src/worker/engine.worker.ts',
  '../../../../packages/engine/src/index.ts',
  '../../../../node_modules/.pnpm/@ciatlas+core@x/node_modules/@ciatlas/core/src/project-browser.ts',
  ZOD,
];
const ELKJS = '../../../../node_modules/.pnpm/elkjs@0.12.0/node_modules/elkjs/lib/elk.bundled.js';
const LAYOUT = ['../../src/worker/layout.worker.ts', '../../src/worker/layout-protocol.ts', ELKJS];

describe('the chunk rules', () => {
  it('pass the page and the workers as the app builds them', () => {
    expect(chunkProblems('index-abc.js', PAGE)).toEqual([]);
    expect(chunkProblems('engine.worker-abc.js', WORKER)).toEqual([]);
    expect(chunkProblems('layout.worker-abc.js', LAYOUT)).toEqual([]);
  });

  it('flag the empty module a client build puts in place of a Node built-in, in any chunk', () => {
    // Vite folds every built-in into one module and lists it among the map's sources.
    for (const [file, sources] of [
      ['index-abc.js', PAGE],
      ['engine.worker-abc.js', WORKER],
    ] as const) {
      const problems = chunkProblems(file, [...sources, '../../../__vite-browser-external']);
      expect(problems).toEqual([expect.stringContaining(`${file} imports a Node built-in`)]);
    }
    expect(chunkProblems('index-abc.js', [...PAGE, '__vite-browser-external:node:fs'])).toHaveLength(1);
  });

  it('keep the Node host out of every chunk', () => {
    const files = '../../../../packages/node/src/files.ts';
    expect(chunkProblems('index-abc.js', [...PAGE, files])).toEqual([
      `index-abc.js holds ${files}, which runs only under Node`,
    ]);
    expect(chunkProblems('engine.worker-abc.js', [...WORKER, files])).toHaveLength(1);
  });

  it('let the page hold the document model’s text edits and nothing else of it, and keep it out of the workers', () => {
    const edits = '../../../../packages/document/src/edits.ts';
    const document = '../../../../packages/document/src/document.ts';
    expect(chunkProblems('index-abc.js', [...PAGE, edits])).toEqual([]);
    expect(chunkProblems('YamlPane-abc.js', [edits])).toEqual([]);
    expect(chunkProblems('index-abc.js', [...PAGE, edits, document])).toEqual([
      `index-abc.js holds ${document}: the page may use only @simulci/document/edits`,
    ]);
    expect(chunkProblems('engine.worker-abc.js', [...WORKER, edits])).toEqual([
      `engine.worker-abc.js holds ${edits}: the document model edits on the page, not here`,
    ]);
    expect(chunkProblems('layout.worker-abc.js', [...LAYOUT, edits])).toHaveLength(1);
  });

  it("let the GitHub source's chunk hold core's remote fetcher and its references, and no other chunk", () => {
    const core = '../../../../node_modules/.pnpm/@ciatlas+core@x/node_modules/@ciatlas/core/src';
    const fetcher = [`${core}/remote-fetch.ts`, `${core}/remote-ref.ts`];
    expect(chunkProblems('github-abc.js', ['../../src/github/github.ts', ...fetcher])).toEqual([]);
    expect(chunkProblems('github-abc.js', [`${core}/remote.ts`])).toHaveLength(1);
    expect(chunkProblems('github-abc.js', [ZOD])).toHaveLength(1);
    expect(chunkProblems('index-abc.js', [...PAGE, ...fetcher])).toHaveLength(2);
    expect(chunkProblems('edit-abc.js', fetcher)).toHaveLength(2);
  });

  it("keeps core's remote fetcher free of anything but its references, which import nothing", () => {
    const core = join(root, 'node_modules/@ciatlas/core/src');
    const imports = (file: string): string[] =>
      [
        ...readFileSync(join(core, file), 'utf8').matchAll(
          /^\s*(?:import|export)\b[^;]*?\bfrom\s*'([^']+)'/gm,
        ),
      ].map((m) => m[1]);
    expect(imports('remote-fetch.ts').sort()).toEqual(['./remote-ref', './remote-ref']);
    expect(imports('remote-ref.ts')).toEqual([]);
    expect(readFileSync(join(core, 'remote-ref.ts'), 'utf8')).not.toMatch(/\bimport\s*\(/);
    expect(readFileSync(join(core, 'remote-fetch.ts'), 'utf8')).not.toMatch(/\bimport\s*\(/);
  });

  it("keep core, zod and the engine proper in the worker, which builds from core's browser entry", () => {
    expect(
      chunkProblems('index-abc.js', [...PAGE, '../../../../packages/engine/src/trigger/push.ts']),
    ).toEqual([
      'index-abc.js holds ../../../../packages/engine/src/trigger/push.ts: the page may use only plan/ and render/',
    ]);
    expect(chunkProblems('index-abc.js', [...PAGE, ZOD])).toHaveLength(1);
    expect(
      chunkProblems(
        'engine.worker-abc.js',
        WORKER.filter((s) => !s.includes('project-browser')),
      ),
    ).toEqual(["engine.worker-abc.js was not built from core's browser entry"]);
  });

  it("keep the yaml package in the worker, and let the YAML pane's CodeMirror grammar on the page", () => {
    const pane = [
      '../../src/yaml/YamlPane.tsx',
      '../../../../node_modules/.pnpm/@lezer+yaml@1.0.3/node_modules/@lezer/yaml/dist/index.js',
      '../../../../node_modules/.pnpm/@codemirror+lang-yaml@6.1.3/node_modules/@codemirror/lang-yaml/dist/index.js',
    ];
    expect(chunkProblems('YamlPane-abc.js', pane)).toEqual([]);
    const yaml = '../../../../node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/index.js';
    expect(chunkProblems('index-abc.js', [...PAGE, yaml])).toEqual([
      `index-abc.js holds ${yaml}, which only the engine worker and the edit runtime may`,
    ]);
    expect(chunkProblems('YamlPane-abc.js', [...pane, yaml])).toHaveLength(1);
    expect(chunkProblems('layout.worker-abc.js', [...LAYOUT, yaml])).toEqual([
      `layout.worker-abc.js holds ${yaml}, which only the engine worker may`,
    ]);
  });

  it('let the edit runtime hold the YAML parser and the whole document model, and nothing else the page may not', () => {
    const yaml = '../../../../node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/composer.js';
    const document = '../../../../packages/document/src/document.ts';
    const edit = ['../../src/edit/edit.ts', '../../src/edit/dispatch.ts', document, yaml];
    expect(chunkProblems('edit-abc.js', edit)).toEqual([]);
    expect(chunkProblems('YamlPane-abc.js', [document])).toEqual([
      `YamlPane-abc.js holds ${document}: the page may use only @simulci/document/edits`,
    ]);
    const core =
      '../../../../node_modules/.pnpm/@ciatlas+core@x/node_modules/@ciatlas/core/src/project-browser.ts';
    const push = '../../../../packages/engine/src/trigger/push.ts';
    expect(chunkProblems('edit-abc.js', [...edit, core, ZOD, ELKJS, push])).toEqual([
      `edit-abc.js holds ${core}, which only the engine worker may`,
      `edit-abc.js holds ${ZOD}, which only the engine worker may`,
      `edit-abc.js holds ${ELKJS}, which only the layout worker may`,
      `edit-abc.js holds ${push}: the page may use only plan/ and render/`,
    ]);
  });

  it('keep the action catalog in a chunk of its own, holding it alone', () => {
    const catalog = '../../src/catalog/catalog.json';
    expect(chunkProblems('catalog-abc.js', [catalog])).toEqual([]);
    expect(chunkProblems('catalog-abc.js', [catalog, '../../src/edit/catalog.ts'])).toEqual([
      'catalog-abc.js holds ../../src/edit/catalog.ts: the catalog chunk holds catalog.json alone',
    ]);
    expect(chunkProblems('catalog-abc.js', ['../../src/edit/catalog.ts'])).toHaveLength(2);
    for (const chunk of ['edit-abc.js', 'index-abc.js', 'engine.worker-abc.js'])
      expect(chunkProblems(chunk, [catalog])).toContain(
        `${chunk} holds ${catalog}, which only the catalog chunk may: import() it`,
      );
  });

  it('keep elkjs in the layout worker, and the engine and what it depends on out of it', () => {
    expect(chunkProblems('index-abc.js', [...PAGE, ELKJS])).toEqual([
      `index-abc.js holds ${ELKJS}, which only the layout worker may`,
    ]);
    expect(chunkProblems('engine.worker-abc.js', [...WORKER, ELKJS])).toEqual([
      `engine.worker-abc.js holds ${ELKJS}, which only the layout worker may`,
    ]);
    const plan = '../../../../packages/engine/src/plan/index.ts';
    expect(chunkProblems('layout.worker-abc.js', [...LAYOUT, plan, ZOD])).toEqual([
      `layout.worker-abc.js holds ${plan}, which only the engine worker may`,
      `layout.worker-abc.js holds ${ZOD}, which only the engine worker may`,
    ]);
    expect(chunkProblems('layout.worker-abc.js', LAYOUT.slice(0, 2))).toEqual([
      'layout.worker-abc.js holds no elkjs, so nothing lays the graph out',
    ]);
  });
});

describe('the web app as it builds', () => {
  let dir = '';
  let chunks: string[] = [];
  const sourcesOf = (chunk: string): string[] =>
    JSON.parse(readFileSync(join(dir, 'assets', `${chunk}.map`), 'utf8')).sources;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'simulci-web-app-'));
    const vite = await import(pathToFileURL(createRequire(join(web, 'package.json')).resolve('vite')).href);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await vite.build({
        root: web,
        configFile: join(web, 'vite.config.ts'),
        logLevel: 'silent',
        build: { outDir: dir, emptyOutDir: true },
      });
    } finally {
      process.env.NODE_ENV = env;
    }
    chunks = readdirSync(join(dir, 'assets')).filter((f) => f.endsWith('.js'));
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('splits the page, the YAML pane, the edit runtime, the dialogs, the catalog, the Tests tab, the GitHub source and the two workers, and no chunk they share', () => {
    // A module two lazy chunks share that the page does not hold goes to a chunk of its own, named after it; so does
    // the page's when rolldown cannot leave it there: a name outside this list is that.
    expect(chunks.map((f) => f.replace(/-[\w-]{8}\.js$/, '')).sort()).toEqual([
      'YamlPane',
      'catalog',
      'dialogs',
      'edit',
      'engine.worker',
      'github',
      'index',
      'layout.worker',
      'tests',
    ]);
    for (const chunk of chunks) expect(chunkProblems(chunk, sourcesOf(chunk))).toEqual([]);
  });

  it('puts the YAML parser and the document model in the edit runtime, and the page loads it only on demand', () => {
    const edit = chunks.find((f) => f.startsWith('edit-'))!;
    const sources = sourcesOf(edit);
    expect(sources.some((s) => s.includes('/node_modules/yaml/'))).toBe(true);
    expect(sources.some((s) => s.endsWith('packages/document/src/document.ts'))).toBe(true);
    expect(sources.some((s) => s.endsWith('src/edit/dispatch.ts'))).toBe(true);
    const page = chunks.find((f) => f.startsWith('index-'))!;
    const code = readFileSync(join(dir, 'assets', page), 'utf8');
    expect(code).toContain(`import(\`./${edit}\`)`);
    expect(code).not.toMatch(new RegExp(`from\\s*["'\`]\\./${edit.replace('.', '\\.')}`));
  });

  it('puts the action catalog alone in its chunk, which the edit runtime loads only on demand', () => {
    const catalog = chunks.find((f) => f.startsWith('catalog-'))!;
    expect(sourcesOf(catalog)).toEqual([expect.stringMatching(/apps\/web\/src\/catalog\/catalog\.json$/)]);
    const edit = readFileSync(
      join(
        dir,
        'assets',
        chunks.find((f) => f.startsWith('edit-'))!,
      ),
      'utf8',
    );
    expect(edit).toContain(`import(\`./${catalog}\`)`);
    const page = readFileSync(
      join(
        dir,
        'assets',
        chunks.find((f) => f.startsWith('index-'))!,
      ),
      'utf8',
    );
    expect(page).not.toContain(catalog);
  });

  it('puts the Changes, save and test case dialogs, the diff, the patch and the folder writes in the dialogs chunk, which the page loads only on demand', () => {
    const dialogs = chunks.find((f) => f.startsWith('dialogs-'))!;
    const page = chunks.find((f) => f.startsWith('index-'))!;
    const lazy = [
      'src/app/ChangesDialog.tsx',
      'src/app/SaveDialog.tsx',
      'src/testcase/CaseDialog.tsx',
      'src/app/RestoreConflicts.tsx',
      'src/app/DiffView.tsx',
      'src/lib/line-diff.ts',
      'src/lib/patch.ts',
      'src/state/changes.ts',
      'src/app/save-run.ts',
      'src/input/save.ts',
      'src/state/reload.ts',
    ];
    // The buttons, the keys, the status line's save line and the permission request stay on the page.
    const kept = [
      'src/app/ChangesButton.tsx',
      'src/app/SaveButton.tsx',
      'src/testcase/CopyAsTest.tsx',
      'src/app/shortcuts.ts',
      'src/app/saver.ts',
    ];
    const holds = (chunk: string, modules: string[]) =>
      modules.filter((m) => sourcesOf(chunk).some((s) => s.endsWith(m)));
    expect(holds(dialogs, lazy)).toEqual(lazy);
    expect(holds(page, lazy)).toEqual([]);
    expect(holds(page, kept)).toEqual(kept);
    const code = readFileSync(join(dir, 'assets', page), 'utf8');
    expect(code).toContain(`import(\`./${dialogs}\`)`);
    expect(code).not.toMatch(new RegExp(`from\\s*["'\`]\\./${dialogs.replace('.', '\\.')}`));
  });
  it('puts the Tests tab in a chunk of its own, reaching no page module but leaves, which the page loads only on demand', () => {
    const tests = chunks.find((f) => f.startsWith('tests-'))!;
    const page = chunks.find((f) => f.startsWith('index-'))!;
    // The page hands the tab its state and actions, so the chunk shares no store, provider or panel kit with the page.
    const app = sourcesOf(tests).filter((s) => s.includes('/src/'));
    expect(app.map((s) => s.replace(/.*\/src\//, 'src/')).sort()).toEqual([
      'src/panels/tests/tests.tsx',
      'src/panels/tests/words.ts',
    ]);
    expect(sourcesOf(page).some((s) => s.endsWith('src/panels/tests/tests.tsx'))).toBe(false);
    const code = readFileSync(join(dir, 'assets', page), 'utf8');
    expect(code).toContain(`import(\`./${tests}\`)`);
    expect(code).not.toMatch(new RegExp(`from\\s*["'\`]\\./${tests.replace('.', '\\.')}`));
  });

  it("puts the GitHub source's reader, client and cache with core's fetcher in a chunk of their own, which the page loads only on demand", () => {
    const github = chunks.find((f) => f.startsWith('github-'))!;
    const page = chunks.find((f) => f.startsWith('index-'))!;
    const lazy = [
      'src/github/github.ts',
      'src/github/repo.ts',
      'src/github/client.ts',
      'src/github/cache.ts',
    ];
    const holds = (chunk: string, modules: string[]) =>
      modules.filter((m) => sourcesOf(chunk).some((s) => s.endsWith(m)));
    expect(holds(github, lazy)).toEqual(lazy);
    expect(holds(page, lazy)).toEqual([]);
    expect(sourcesOf(github).some((s) => s.endsWith('@ciatlas/core/src/remote-fetch.ts'))).toBe(true);
    // Only the loader stays on the page.
    expect(holds(page, ['src/github/load.ts'])).toEqual(['src/github/load.ts']);
    const code = readFileSync(join(dir, 'assets', page), 'utf8');
    expect(code).toContain(`import(\`./${github}\`)`);
    expect(code).not.toMatch(new RegExp(`from\\s*["'\`]\\./${github.replace('.', '\\.')}`));
  });
});

describe('the stylesheet rule', () => {
  it('flags a font face inlined as a data: URI, which font-src self refuses', () => {
    const face = (src: string) =>
      `@font-face{font-family:Mono;font-display:swap;src:${src}format("woff2-variations")}`;
    expect(stylesheetProblems('index-abc.css', face('url(data:font/woff2;base64,d09GMgABAAAA)'))).toEqual([
      expect.stringContaining('index-abc.css inlines a font as a data: URI'),
    ]);
    expect(
      stylesheetProblems('index-abc.css', face(`url("data:application/font-woff2;base64,d09G")`)),
    ).toHaveLength(1);
    expect(stylesheetProblems('index-abc.css', face('url(/assets/mono-latin-B9CIFXIH.woff2)'))).toEqual([]);
    // img-src allows data:, so an inlined image is fine.
    expect(
      stylesheetProblems('index-abc.css', '.x{background:url(data:image/svg+xml;base64,PHN2Zz4=)}'),
    ).toEqual([]);
  });
});

/** The declarations of the rule an opening pattern matches, by property. */
function declarations(css: string, opening: RegExp): Record<string, string> {
  const body = new RegExp(`${opening.source}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  const pairs = body.split(';').map((d) => d.split(':').map((part) => part.trim()));
  return Object.fromEntries(pairs.filter(([property, value]) => property && value));
}

describe("what the web app's Vite config builds", () => {
  let dir = '';
  let assets: string[] = [];
  const read = (file: string) => readFileSync(join(dir, 'dist/assets', file), 'utf8');
  const stylesheet = () => assets.filter((f) => f.endsWith('.css'));

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'simulci-web-bundle-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><script type="module" src="./main.js"></script>');
    writeFileSync(
      join(dir, 'main.js'),
      [
        `import ${JSON.stringify(join(web, 'src/index.css'))};`,
        "import './face.css';",
        "import { readFileSync } from 'node:fs';",
        `import { spawnLayoutWorker } from ${JSON.stringify(join(web, 'src/worker/layout-client.ts'))};`,
        'console.log(readFileSync, spawnLayoutWorker);',
      ].join('\n'),
    );
    // Under Vite's 4 kB inline limit, whatever the font packages ship.
    writeFileSync(join(dir, 'small.woff2'), Buffer.alloc(2048, 1));
    writeFileSync(
      join(dir, 'face.css'),
      "@font-face { font-family: Probe; src: url('./small.woff2') format('woff2'); }\n",
    );
    const vite = await import(pathToFileURL(createRequire(join(web, 'package.json')).resolve('vite')).href);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await vite.build({
        root: dir,
        configFile: join(web, 'vite.config.ts'),
        logLevel: 'silent',
        build: { outDir: join(dir, 'dist') },
      });
    } finally {
      process.env.NODE_ENV = env;
    }
    assets = readdirSync(join(dir, 'dist/assets'));
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps every font a file, which font-src self allows, the 2 kB Cyrillic-extended JetBrains Mono face too', () => {
    expect(stylesheet()).toHaveLength(1);
    for (const file of stylesheet()) expect(stylesheetProblems(file, read(file))).toEqual([]);
    expect(
      assets.filter((f) => /^(small|jetbrains-mono-cyrillic-ext-wght-normal)-.*\.woff2$/.test(f)),
    ).toHaveLength(2);
  });

  it('keys the dark ramp on data-theme, which public/theme.js sets before the first paint', () => {
    const css = stylesheet().map(read).join('\n');
    const dark = declarations(css, /:root\[data-theme=['"]?dark['"]?\]/);
    expect(dark['color-scheme']).toBe('dark');
    expect(Object.keys(dark).length).toBeGreaterThan(10);
  });

  it('leaves a Node built-in where the chunk rules see it', () => {
    const chunk = assets.find((f) => f.startsWith('index-') && f.endsWith('.js'))!;
    const sources: string[] = JSON.parse(read(`${chunk}.map`)).sources;
    expect(chunkProblems(chunk, sources)).toEqual([
      expect.stringContaining(`${chunk} imports a Node built-in`),
    ]);
  });

  it('builds the layout worker into a chunk of its own, holding elkjs and keeping the rules', () => {
    const chunks = assets.filter((f) => /^layout\.worker-.*\.js$/.test(f));
    expect(chunks).toHaveLength(1);
    const sources: string[] = JSON.parse(read(`${chunks[0]}.map`)).sources;
    expect(sources.some((s) => s.includes('/elkjs/'))).toBe(true);
    expect(chunkProblems(chunks[0], sources)).toEqual([]);
  });

  it('runs the built layout worker where a global scope without a document is what ELK finds', async () => {
    const listeners: ((event: { origin: string; source: null; data: unknown }) => void)[] = [];
    const posted: LayoutResponse[] = [];
    const chunk = assets.find((f) => /^layout\.worker-.*\.js$/.test(f))!;
    // Node reads a .js file outside a package by its syntax; .mjs says what it is.
    const copy = join(dir, 'dist/assets', 'layout-worker.mjs');
    copyFileSync(join(dir, 'dist/assets', chunk), copy);
    vi.stubGlobal('self', globalThis);
    // The worker's message listener; the CSP listener it adds first (worker/csp.ts) is not under test here.
    vi.stubGlobal('addEventListener', (type: string, l: (typeof listeners)[number]) => {
      if (type === 'message') listeners.push(l);
    });
    vi.stubGlobal('postMessage', (m: LayoutResponse) => posted.push(m));
    try {
      await import(pathToFileURL(copy).href);
      const request: LayoutRequest = {
        id: 1,
        type: 'layout',
        scopes: [
          {
            id: 'ci.yml',
            nodes: [
              { id: 'ci.yml#a', width: 168, height: 50 },
              { id: 'ci.yml#b', width: 168, height: 50 },
            ],
            edges: [{ id: 'ci.yml#a->ci.yml#b', source: 'ci.yml#a', target: 'ci.yml#b' }],
          },
        ],
        known: {},
      };
      listeners[0]({ origin: '', source: null, data: request });
      await vi.waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]).toMatchObject({
        id: 1,
        type: 'layout',
        scopes: { 'ci.yml': { positions: { 'ci.yml#a': { x: 16, y: 40 }, 'ci.yml#b': { x: 232, y: 40 } } } },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('applyTheme', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sets data-theme to the theme the author chose, or to the OS scheme while it follows the system', () => {
    const attributes: Record<string, string> = {};
    let onChange: (() => void) | undefined;
    const query = {
      matches: true,
      addEventListener: (_: string, f: () => void) => (onChange = f),
      removeEventListener: () => (onChange = undefined),
    };
    vi.stubGlobal('document', {
      documentElement: { setAttribute: (k: string, v: string) => (attributes[k] = v) },
    });
    vi.stubGlobal('window', { matchMedia: () => query });
    applyTheme('system');
    expect(attributes['data-theme']).toBe('dark');
    query.matches = false;
    onChange?.();
    expect(attributes['data-theme']).toBe('light');
    applyTheme('dark');
    expect(attributes['data-theme']).toBe('dark');
    expect(onChange).toBeUndefined();
    applyTheme('light');
    expect(attributes['data-theme']).toBe('light');
  });
});
