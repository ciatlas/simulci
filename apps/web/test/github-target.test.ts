import { describe, expect, it } from 'vitest';
import { parseRepoInput } from '../src/github/target';
import { isTarget, parseTargetText, targetText } from '../src/lib/repo-words';

/** What the Open GitHub repository field takes (M4 synthesis § 5.5), and the URL's `gh` spelling of it. */
describe('the repository field', () => {
  it('takes a name, a name at a ref, and github.com links to the repository, a tree, a file and a commit', () => {
    const cases: [string, object][] = [
      ['octo/ship', { owner: 'octo', repo: 'ship' }],
      ['  octo/ship@v1.2  ', { owner: 'octo', repo: 'ship', ref: 'v1.2' }],
      ['octo/ship@feature/x', { owner: 'octo', repo: 'ship', ref: 'feature/x' }],
      ['https://github.com/octo/ship', { owner: 'octo', repo: 'ship' }],
      ['github.com/octo/ship.git', { owner: 'octo', repo: 'ship' }],
      ['https://www.github.com/octo/ship/', { owner: 'octo', repo: 'ship' }],
      ['https://github.com/octo/ship/tree/dev/.github', { owner: 'octo', repo: 'ship', ref: 'dev' }],
      [
        'https://github.com/octo/ship/blob/main/.github/workflows/ci.yml',
        { owner: 'octo', repo: 'ship', ref: 'main' },
      ],
      [
        `https://github.com/octo/ship/commit/${'a'.repeat(40)}`,
        { owner: 'octo', repo: 'ship', ref: 'a'.repeat(40) },
      ],
      ['https://github.com/octo/ship/issues', { owner: 'octo', repo: 'ship' }],
    ];
    for (const [input, target] of cases) {
      const parsed = parseRepoInput(input);
      expect(parsed.ok && parsed.target, input).toEqual(target);
    }
    // A tree's or a file's path is kept from the ref on: a branch may have a `/` in its name.
    expect(parseRepoInput('https://github.com/octo/ship/tree/dev/.github')).toMatchObject({
      segments: ['dev', '.github'],
    });
    expect(parseRepoInput('octo/ship@dev')).not.toHaveProperty('segments');
  });

  it('says why a pull request or another host does not open, and nothing of what is typed halfway', () => {
    expect(parseRepoInput('https://github.com/octo/ship/pull/42')).toEqual({
      ok: false,
      message: 'simulci opens a pull request in a later version: open its repository at the branch for now.',
    });
    expect(parseRepoInput('https://ghe.example.com/octo/ship')).toEqual({
      ok: false,
      message: 'GitHub Enterprise Server needs a self-hosted simulci.',
    });
    for (const input of [
      '',
      'octo',
      'octo/',
      'octo/ship@',
      '-octo/ship',
      'octo/..',
      'https://github.com/octo',
      'https://github.com/octo/ship/tree/%zz',
    ])
      expect(parseRepoInput(input), input).toEqual({ ok: false });
  });

  it('spells a target for the URL and reads it back, and knows the source it names', () => {
    expect(targetText({ owner: 'octo', repo: 'ship', ref: 'v1' })).toBe('octo/ship@v1');
    expect(parseTargetText('octo/ship@v1')).toEqual({ owner: 'octo', repo: 'ship', ref: 'v1' });
    const source = {
      kind: 'github' as const,
      host: 'github.com',
      owner: 'Octo',
      repo: 'Ship',
      ref: 'main',
      sha: 'a'.repeat(40),
      defaultBranch: 'main',
      private: false,
      readAt: 0,
    };
    expect(isTarget(source, { owner: 'octo', repo: 'ship' })).toBe(true);
    expect(isTarget(source, { owner: 'octo', repo: 'ship', ref: 'main' })).toBe(true);
    expect(isTarget(source, { owner: 'octo', repo: 'ship', ref: 'dev' })).toBe(false);
    expect(isTarget({ kind: 'none' }, { owner: 'octo', repo: 'ship' })).toBe(false);
  });
});
