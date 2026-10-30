import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { asWritten } from '../src/input/read';
import { filePatch, type PatchFile, patchOf } from '../src/lib/patch';
import { PATCH_NAME } from '../src/lib/repo-words';

const CI = '.github/workflows/ci.yml';

describe('filePatch', () => {
  it('writes a git-style patch with a/ and b/ paths and three lines of context', () => {
    const before = 'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n';
    const after = 'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-24.04\n';
    expect(filePatch({ path: CI, before, after })).toBe(
      [
        `diff --git a/${CI} b/${CI}`,
        `--- a/${CI}`,
        `+++ b/${CI}`,
        '@@ -2,4 +2,4 @@',
        ' on: push',
        ' jobs:',
        '   build:',
        '-    runs-on: ubuntu-latest',
        '+    runs-on: ubuntu-24.04',
        '',
      ].join('\n'),
    );
  });

  it('takes a created file from /dev/null and a removed one to it', () => {
    expect(filePatch({ path: CI, after: 'a\nb\n' })).toBe(
      `diff --git a/${CI} b/${CI}\nnew file mode 100644\n--- /dev/null\n+++ b/${CI}\n@@ -0,0 +1,2 @@\n+a\n+b\n`,
    );
    expect(filePatch({ path: CI, before: 'a\n' })).toBe(
      `diff --git a/${CI} b/${CI}\ndeleted file mode 100644\n--- a/${CI}\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n`,
    );
    expect(filePatch({ path: CI, after: '' })).toBe(`diff --git a/${CI} b/${CI}\nnew file mode 100644\n`);
  });

  it('keeps CRLF in content lines and says when a last line has no line break', () => {
    expect(filePatch({ path: CI, before: 'a\r\nb', after: 'a\r\nc' })).toBe(
      `diff --git a/${CI} b/${CI}\n--- a/${CI}\n+++ b/${CI}\n@@ -1,2 +1,2 @@\n a\r\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n`,
    );
  });

  it('quotes a name git would quote, and ends one with a space by a tab', () => {
    expect(filePatch({ path: 'naïve "x".yml', after: 'a\n' }).split('\n').slice(0, 1)).toEqual([
      'diff --git "a/na\\303\\257ve \\"x\\".yml" "b/na\\303\\257ve \\"x\\".yml"',
    ]);
    expect(filePatch({ path: 'my ci.yml', before: 'a\n', after: 'b\n' })).toContain('--- a/my ci.yml\t\n');
  });

  it('has nothing to say of a file left as it was', () => {
    expect(filePatch({ path: CI, before: 'a\n', after: 'a\n' })).toBe('');
    expect(patchOf([])).toBe('');
  });
});

/**
 * The patch applied by git itself (synthesis § 9.7, A6's item), over LF, CRLF and BOM files, a file created, an
 * empty one created, a file removed, a last line without a break and names git quotes, under each `core.autocrlf`.
 * What git does past the patch is its own: with `core.autocrlf=true` it writes every file it touches with CRLF, as a
 * checkout would, and it warns of a created file's CRLF lines as trailing whitespace (an edited file whose lines
 * had CRLF already is not warned of), which `apply.whitespace=error` would refuse.
 */
describe('git apply', () => {
  const BOM = { bom: true };
  const cases: { path: string; before?: string; after?: string; bom?: boolean }[] = [
    {
      path: '.github/workflows/lf.yml',
      before: lines(12, '\n'),
      after: lines(12, '\n').replace('line 3\n', 'line three\n').replace('line 11\n', ''),
    },
    {
      path: '.github/workflows/crlf.yml',
      before: lines(12, '\r\n'),
      after: lines(12, '\r\n').replace('line 6\r\n', 'line 6\r\ninserted\r\n'),
    },
    {
      path: '.github/workflows/bom.yml',
      before: lines(5, '\r\n'),
      after: lines(5, '\r\n').replace('line 1\r\n', 'first\r\n'),
      ...BOM,
    },
    { path: '.github/workflows/created.yml', after: 'name: New\r\non: push\r\n' },
    { path: '.github/workflows/empty.yml', after: '' },
    { path: '.github/workflows/removed.yml', before: lines(4, '\n') },
    { path: '.github/workflows/no break.yml', before: 'a\nb', after: 'a\nb\nc' },
    { path: '.github/workflows/naïve.yml', before: 'a\n', after: 'b\n' },
  ];
  const files = cases.map(({ path, before, after, bom }): PatchFile => ({
    path,
    before: before === undefined ? undefined : asWritten(before, { bom: bom === true }),
    after: after === undefined ? undefined : asWritten(after, { bom: bom === true }),
  }));
  // A GitHub source's patch opens with a line naming the commit (M4 synthesis § 5.7), which git reads past.
  const patches: Record<string, string> = {
    plain: patchOf(files),
    'with a preamble': patchOf(files, 'simulci: changes against octo/ship@3f2a9c1 (main)'),
  };
  const root = mkdtempSync(join(tmpdir(), 'simulci-patch-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it.each(
    ['false', 'true', 'input'].flatMap((autocrlf) => Object.keys(patches).map((kind) => [autocrlf, kind])),
  )('applies cleanly under core.autocrlf=%s, %s', (autocrlf, kind) => {
    const patch = patches[kind]!;
    const dir = join(root, `${autocrlf}-${kind.replaceAll(' ', '-')}`);
    mkdirSync(dir);
    // Nothing of this machine's git configuration: no global or system file, no attributes file.
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(root, 'none'),
      HOME: root,
      XDG_CONFIG_HOME: root,
    };
    const git = (...args: string[]): string => {
      const run = spawnSync('git', ['-c', `core.autocrlf=${autocrlf}`, ...args], {
        cwd: dir,
        env,
        encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(0);
      return run.stderr;
    };
    git('init', '-q');
    for (const { path, before, bom } of cases)
      if (before !== undefined) write(join(dir, path), asWritten(before, { bom: bom === true }));
    writeFileSync(join(dir, PATCH_NAME), patch);
    git('apply', '--check', PATCH_NAME);
    // Only the created file's CRLF lines are warned of.
    const warned = [...git('apply', PATCH_NAME).matchAll(/^.*:(\d+): trailing whitespace\.$/gm)].map((m) =>
      Number(m[1]),
    );
    expect(warned.map((line) => patch.split('\n')[line - 1])).toEqual(['+name: New\r', '+on: push\r']);
    for (const { path, after, bom } of cases) {
      const file = join(dir, path);
      if (after === undefined) expect(() => readFileSync(file)).toThrow(/ENOENT/);
      else {
        const written = asWritten(after, { bom: bom === true });
        expect(readFileSync(file, 'utf8')).toBe(
          autocrlf === 'true' ? written.replace(/\r?\n/g, '\r\n') : written,
        );
      }
    }
  });
});

function lines(count: number, eol: string): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}${eol}`).join('');
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
