import { defineConfig } from 'fumadocs-mdx/config';
import { remarkAccuracy } from './lib/remark-accuracy';

/** fumadocs-mdx's MDX options for every page (lib/source.ts declares the collection): its defaults, and the figures. */
export default defineConfig({
  mdxOptions: { remarkPlugins: (plugins) => [remarkAccuracy, ...plugins] },
});
