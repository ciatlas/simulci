/**
 * The rules the browser bundle keeps, as pure functions over one built asset: a chunk's name and the sources its
 * source map lists, or a stylesheet's name and code. scripts/check-web-bundle.mjs applies them to apps/web/dist; the
 * tests apply them to small inputs and to what the web app's Vite config builds.
 */

/** What only the engine worker may hold: the engine's dependencies but the YAML parser. */
const ENGINE_WORKER_ONLY = [/@ciatlas\/core\//, /\/@actions\//, /\/zod\//, /picomatch/, /cronstrue/];
/**
 * The YAML parser: the engine worker's, and the edit runtime's, which edits the text on the page (synthesis § 8.5).
 * Matched as a package, so the YAML pane's CodeMirror grammar (`@lezer/yaml`, `@codemirror/lang-yaml`) stays allowed.
 */
const YAML = /node_modules\/yaml\//;
/** What only the layout worker may hold. */
const ELKJS = /\/elkjs\//;
/** Engine sources the page may use: the core-free entries. */
const PAGE_ENGINE_OK = /packages\/engine\/src\/(plan|render)\//;
const ENGINE = /packages\/engine\/src\//;
/**
 * The document model, and the one module of it the page may hold: its text edits, which import nothing. The rest is
 * the edit runtime's (`edit-*`).
 */
const DOCUMENT = /packages\/document\/src\//;
const PAGE_DOCUMENT_OK = /packages\/document\/src\/edits\.ts$/;
/**
 * The bundled action catalog (synthesis § 8.5): the one source of the `catalog-*` chunk, which the edit runtime fetches
 * with `import()` as the palette or Properties asks, and of no other chunk.
 */
const CATALOG = /(?:^|\/)src\/catalog\/catalog\.json$/;
/** The Node host (@simulci/node): it reads the checkout from disk, which neither the page nor the worker can. */
const NODE_HOST = /packages\/node\/src\//;
/**
 * The module a Vite client build puts in place of a Node built-in. In production it is `module.exports = {}`, so the
 * build passes and the call fails in the browser. The code keeps no trace of the import; the source map lists the
 * module, as `__vite-browser-external` (or `__vite-browser-external:node:fs` outside production).
 */
const BROWSER_EXTERNAL = /(?:^|\/)__vite-browser-external(?::|$)/;
/** A font face whose source is a data: URI. */
const DATA_FONT = /@font-face\s*\{[^}]*url\(\s*['"]?data:/;

const isEngineWorker = (file) => file.startsWith('engine.worker-');
const isLayoutWorker = (file) => file.startsWith('layout.worker-');
/** The edit runtime, fetched when the author edits: the page's but for the document model and its YAML parser. */
const isEditRuntime = (file) => file.startsWith('edit-');
const isCatalog = (file) => file.startsWith('catalog-');

/**
 * What breaks the contract in one JavaScript chunk.
 * @param {string} file the chunk's name under assets/
 * @param {readonly string[]} sources the sources its map lists
 * @returns {string[]}
 */
export function chunkProblems(file, sources) {
  const problems = [];
  for (const s of sources) {
    if (BROWSER_EXTERNAL.test(s))
      problems.push(
        `${file} imports a Node built-in, which the browser build replaced with an empty module (the build log says which: "externalized for browser compatibility")`,
      );
    if (NODE_HOST.test(s)) problems.push(`${file} holds ${s}, which runs only under Node`);
  }
  if (isCatalog(file)) return [...problems, ...catalogProblems(file, sources)];
  for (const s of sources)
    if (CATALOG.test(s)) problems.push(`${file} holds ${s}, which only the catalog chunk may: import() it`);
  if (isEngineWorker(file)) problems.push(...engineWorkerProblems(file, sources));
  else if (isLayoutWorker(file)) problems.push(...layoutWorkerProblems(file, sources));
  else problems.push(...pageProblems(file, sources));
  return problems;
}

/** The catalog chunk is the catalog's JSON and nothing else: a module joining it would load with the catalog. */
function catalogProblems(file, sources) {
  const problems = sources
    .filter((s) => !CATALOG.test(s))
    .map((s) => `${file} holds ${s}: the catalog chunk holds catalog.json alone`);
  if (!sources.some((s) => CATALOG.test(s))) problems.push(`${file} holds no catalog.json`);
  return problems;
}

/** The engine worker builds from core's browser entry, without its file-system and git modules, and without ELK. */
function engineWorkerProblems(file, sources) {
  const problems = [];
  if (!sources.some((s) => s.includes('project-browser')))
    problems.push(`${file} was not built from core's browser entry`);
  for (const s of sources) {
    if (/node-fs\.ts|\/git\.ts/.test(s) && s.includes('@ciatlas/core')) problems.push(`${file} holds ${s}`);
    if (ELKJS.test(s)) problems.push(`${file} holds ${s}, which only the layout worker may`);
    if (DOCUMENT.test(s)) problems.push(`${file} holds ${s}: the document model edits on the page, not here`);
  }
  return problems;
}

/** The layout worker is ELK and the protocol around it: none of the engine, nor what the engine depends on. */
function layoutWorkerProblems(file, sources) {
  const problems = [];
  if (!sources.some((s) => ELKJS.test(s)))
    problems.push(`${file} holds no elkjs, so nothing lays the graph out`);
  for (const s of sources) {
    if (ENGINE.test(s) || ENGINE_WORKER_ONLY.some((re) => re.test(s)) || YAML.test(s))
      problems.push(`${file} holds ${s}, which only the engine worker may`);
    if (DOCUMENT.test(s)) problems.push(`${file} holds ${s}: the document model edits on the page, not here`);
  }
  return problems;
}

/**
 * The page holds none of the engine but its plan/ and render/ entries, none of the document model but its text edits
 * (the edit history's and the pane's), and nothing that only a worker may. The edit runtime is a page chunk that may
 * also hold the document model and the YAML parser; a lazy chunk of the page (the YAML pane) may hold neither.
 */
function pageProblems(file, sources) {
  const problems = [];
  const edit = isEditRuntime(file);
  for (const s of sources) {
    if (ENGINE_WORKER_ONLY.some((re) => re.test(s)))
      problems.push(`${file} holds ${s}, which only the engine worker may`);
    if (YAML.test(s) && !edit)
      problems.push(`${file} holds ${s}, which only the engine worker and the edit runtime may`);
    if (ELKJS.test(s)) problems.push(`${file} holds ${s}, which only the layout worker may`);
    if (ENGINE.test(s) && !PAGE_ENGINE_OK.test(s))
      problems.push(`${file} holds ${s}: the page may use only plan/ and render/`);
    if (DOCUMENT.test(s) && !PAGE_DOCUMENT_OK.test(s) && !edit)
      problems.push(`${file} holds ${s}: the page may use only @simulci/document/edits`);
  }
  return problems;
}

/**
 * What breaks the contract in one stylesheet: a font inlined as a data: URI, which the deployment's CSP
 * (`font-src 'self'`, apps/web/headers.ts) refuses, so its glyphs fall back to another face.
 * @param {string} file the stylesheet's name under assets/
 * @param {string} code its text
 * @returns {string[]}
 */
export function stylesheetProblems(file, code) {
  return DATA_FONT.test(code)
    ? [`${file} inlines a font as a data: URI, which font-src 'self' refuses; keep fonts as files`]
    : [];
}
