import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';
import { vercelHeaders } from './vercel-headers.ts';

const FONT = /\.(?:woff2?|ttf|otf|eot)$/;

export default defineConfig({
  // `vite preview` (the browser pass) serves the header table's headers as Vercel does (headers.ts), the CSP among them.
  plugins: [react(), tailwindcss(), vercelHeaders()],
  resolve: {
    // The engine and @ciatlas/core ship TypeScript source under the `source` export condition; core's `browser`
    // condition (one of the defaults) picks its entry without node:fs, node:path or git.
    conditions: ['source', ...defaultClientConditions],
  },
  // The engine runs in an ES module worker, so it can be a chunk of its own.
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    sourcemap: true,
    // A font stays a file, however small: the CSP's font-src 'self' (headers.ts) refuses a data: URI. Other assets
    // follow Vite's 4 kB rule.
    assetsInlineLimit: (file) => (FONT.test(file) ? false : undefined),
  },
});
