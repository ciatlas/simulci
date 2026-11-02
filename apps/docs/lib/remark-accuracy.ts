import { replaceSource } from 'fumadocs-core/mdx-plugins/stringifier';
import { PAGE_VALUES } from '../app/(home)/accuracy';

/**
 * A remark plugin: a name of `PAGE_VALUES` in braces (`{accuracy.exact}`) becomes its text when the site builds, in
 * the page and in the Markdown fumadocs keeps of it (llms-full.txt, search), so each holds the numbers accuracy.json
 * has and none is typed into a page. A dotted name that is not one of them fails the build.
 */

type File = Parameters<typeof replaceSource>[0];
type Nodes = Parameters<typeof replaceSource>[1];

interface Node {
  type: string;
  value?: string;
  children?: Node[];
}

const NAME = /^\s*([a-z]+(?:\.[a-z]+)+)\s*$/;

export function remarkAccuracy(values: Record<string, string> = PAGE_VALUES) {
  return (tree: Node, file: File): void => fill(tree, file, values);
}

function fill(node: Node, file: File, values: Record<string, string>): void {
  for (const [i, child] of (node.children ?? []).entries()) {
    const name = nameOf(child);
    if (name === undefined) fill(child, file, values);
    else node.children![i] = written(child, file, valueOf(values, name));
  }
}

/** The dotted name an expression node holds, as `{accuracy.exact}` writes it; none for any other node. */
function nameOf(node: Node): string | undefined {
  if (node.type !== 'mdxTextExpression' && node.type !== 'mdxFlowExpression') return undefined;
  return NAME.exec(node.value ?? '')?.[1];
}

function valueOf(values: Record<string, string>, name: string): string {
  const value = values[name];
  if (value === undefined) throw new Error(`{${name}}: no such value (app/(home)/accuracy.ts PAGE_VALUES)`);
  return value;
}

/** The expression as its text: in the tree, and in the Markdown fumadocs keeps of the page. */
function written(node: Node, file: File, value: string): Node {
  replaceSource(file, node as Nodes, value);
  const text = { type: 'text', value };
  return node.type === 'mdxFlowExpression' ? { type: 'paragraph', children: [text] } : text;
}
