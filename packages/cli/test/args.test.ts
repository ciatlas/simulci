import { describe, expect, it } from 'vitest';
import { exitCodeOf, FlagError, oneOf, spoken } from '../src/args';

describe('oneOf', () => {
  it('passes a value it takes, and names the choices for one it does not', () => {
    expect(oneOf('format', 'json', ['text', 'json', 'mermaid'])).toBe('json');
    expect(() => oneOf('format', 'jsno', ['text', 'json', 'mermaid'])).toThrow(
      new FlagError("--format takes text, json or mermaid, not 'jsno'"),
    );
    expect(() => oneOf('detail', '', ['steps', 'legs'])).toThrow(
      new FlagError("--detail takes steps or legs, not ''"),
    );
    expect(spoken(['jobs'])).toBe('jobs');
  });
});

describe('exitCodeOf', () => {
  const io = (env: Record<string, string> = {}) => {
    const err: string[] = [];
    return { err, stderr: (t: string) => err.push(t), env };
  };

  it("is the body's code, or 2 with the error's message on one line", async () => {
    const quiet = io();
    expect(await exitCodeOf(() => 1, quiet)).toBe(1);
    expect(
      await exitCodeOf(() => {
        throw new Error('EACCES: permission denied');
      }, quiet),
    ).toBe(2);
    expect(
      await exitCodeOf(() => {
        throw 'not an error';
      }, quiet),
    ).toBe(2);
    expect(quiet.err).toEqual(['EACCES: permission denied\n', 'not an error\n']);
  });

  it('prints the stack under SIMULCI_DEBUG=1', async () => {
    const debug = io({ SIMULCI_DEBUG: '1' });
    await exitCodeOf(() => {
      throw new Error('boom');
    }, debug);
    expect(debug.err.join('')).toMatch(/^Error: boom\n {4}at /);
  });
});
