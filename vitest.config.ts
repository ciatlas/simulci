import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // @ciatlas/core is a git dependency that ships its TypeScript source (github:ciatlas/core#vX.Y.Z), never built.
      // Its subpath first (the web app's GitHub source), for the same prefix reason as below.
      '@ciatlas/core/remote-fetch': fileURLToPath(
        new URL('./node_modules/@ciatlas/core/src/remote-fetch.ts', import.meta.url),
      ),
      '@ciatlas/core': fileURLToPath(new URL('./node_modules/@ciatlas/core/src/index.ts', import.meta.url)),
      // Subpaths before the root: an alias matches by prefix, so the root would swallow `@simulci/engine/plan`.
      '@simulci/engine/plan': fileURLToPath(new URL('./packages/engine/src/plan/index.ts', import.meta.url)),
      '@simulci/engine/render': fileURLToPath(
        new URL('./packages/engine/src/render/index.ts', import.meta.url),
      ),
      '@simulci/document/edits': fileURLToPath(new URL('./packages/document/src/edits.ts', import.meta.url)),
      '@simulci/document': src('document'),
      '@simulci/engine': src('engine'),
      '@simulci/node': src('node'),
    },
  },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.tsx',
      'scripts/test/**/*.test.ts',
    ],
    // @actions/workflow-parser imports JSON without import attributes; let Vite transform it like a bundler does.
    server: { deps: { inline: [/@actions\/workflow-parser/, /@actions\/expressions/, /@ciatlas\/core/] } },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      reporter: ['text-summary', 'html', 'json-summary'],
      thresholds: {
        lines: 80,
        'packages/engine/src/**': { lines: 90 },
        'packages/document/src/**': { lines: 90 },
      },
    },
  },
});
