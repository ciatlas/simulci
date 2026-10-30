import { diffLines, hunkHeader, hunksOf, linesOf } from './line-diff';

/**
 * Every change as one git-style patch (synthesis § 5.2, resolved contradiction 21): what a source without a folder
 * handle saves instead, reviewable and `git apply`-able at the repository's root. Paths are `a/` and `b/` the file's
 * path in the project; a created file comes from `/dev/null` and a removed one goes there. Content lines are the
 * file's bytes as they would be written: a CRLF stays in the line, and a BOM file's first line carries U+FEFF on both
 * sides (the caller passes the texts through `asWritten`). A preamble, a line naming what the changes are against
 * (`lib/repo-words.ts`), may come first: `git apply` reads nothing before the first `diff --git`.
 */

/** One file's two sides as a file holds them: no `before` for a file created, no `after` for one removed. */
export interface PatchFile {
  path: string;
  before?: string;
  after?: string;
}

/** The files' patches one after another, after the preamble if any; a file whose two sides are equal has none. */
export const patchOf = (files: readonly PatchFile[], preamble?: string): string =>
  `${preamble === undefined ? '' : `${preamble}\n`}${files.map(filePatch).join('')}`;

export function filePatch({ path, before, after }: PatchFile): string {
  if (before === after) return '';
  const a = quoted(`a/${path}`);
  const b = quoted(`b/${path}`);
  let out = `diff --git ${a} ${b}\n`;
  if (before === undefined) out += 'new file mode 100644\n';
  if (after === undefined) out += 'deleted file mode 100644\n';
  const old = linesOf(before ?? '');
  const now = linesOf(after ?? '');
  const hunks = hunksOf(old, now, diffLines(old, now));
  // An empty file created or removed has no hunk, and so no ---/+++ lines either.
  if (hunks.length === 0) return out;
  // Git ends a name with a space by a tab on these lines, so a trailing date-like field cannot be read into it.
  const tab = path.includes(' ') ? '\t' : '';
  out += `--- ${before === undefined ? '/dev/null' : a}${tab}\n`;
  out += `+++ ${after === undefined ? '/dev/null' : b}${tab}\n`;
  for (const h of hunks) {
    out += `${hunkHeader(h)}\n`;
    for (const line of h.lines)
      out += line.text.endsWith('\n')
        ? `${line.kind}${line.text}`
        : `${line.kind}${line.text}\n\\ No newline at end of file\n`;
  }
  return out;
}

const ESCAPES: Readonly<Record<number, string>> = {
  7: '\\a',
  8: '\\b',
  9: '\\t',
  10: '\\n',
  11: '\\v',
  12: '\\f',
  13: '\\r',
  34: '\\"',
  92: '\\\\',
};

/**
 * A name as git quotes it (`quote_c_style`, `core.quotePath` on): untouched unless it holds a control character, a
 * quote, a backslash or a byte past ASCII; then in double quotes, with C escapes and each such byte in octal.
 */
function quoted(name: string): string {
  if (!/[^ -~]|["\\]/.test(name)) return name;
  let out = '';
  for (const byte of new TextEncoder().encode(name))
    out +=
      ESCAPES[byte] ??
      (byte < 0x20 || byte >= 0x7f ? `\\${byte.toString(8).padStart(3, '0')}` : String.fromCharCode(byte));
  return `"${out}"`;
}
