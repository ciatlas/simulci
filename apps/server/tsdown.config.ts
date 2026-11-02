import { defineConfig } from 'tsdown';

export default defineConfig({
  // dist/server.mjs is the image's /app/server.mjs. Everything is bundled into it (Hono, its Node adapter, zod and the
  // header table, apps/web/headers.ts), so the image holds no node_modules.
  entry: { server: 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  clean: true,
  dts: false,
  fixedExtension: true,
  deps: { onlyBundle: ['@hono/node-server', 'hono', 'zod'] },
});
