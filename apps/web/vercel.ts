import { headerRules, REWRITES, VERCEL } from './headers.ts';

/**
 * The Vercel project `simulci` (root apps/web), read by Vercel at each deployment in place of a vercel.json: its
 * headers and rewrites are the header table's (headers.ts) in Vercel's mode, so no copy of them can drift.
 */
export const config = {
  framework: null,
  installCommand: 'corepack pnpm install --frozen-lockfile --filter @simulci/web...',
  buildCommand: 'corepack pnpm run build',
  outputDirectory: 'dist',
  rewrites: REWRITES,
  headers: headerRules(VERCEL),
};
