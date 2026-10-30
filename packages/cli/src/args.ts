import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type ParseArgsOptionsConfig, parseArgs as tokenize } from 'node:util';
import type { AssumeEntry } from '@simulci/engine';
import { AssumeError, parseAssume } from '@simulci/node';
import { type ArgsDef, parseArgs } from 'citty';

/** How `readArgs` departs from citty for some flags. */
export interface ReadOptions {
  /** Flags that keep every value they are given, in order. */
  repeated?: readonly string[];
  /** Flags whose value may be left out, with the value they then take. */
  bare?: Readonly<Record<string, string>>;
}

/**
 * A command line as citty reads it, with two of its gaps filled. citty 0.2 parses with node:util's parseArgs and no
 * `multiple`, so a flag given twice keeps only its last value: a `repeated` flag keeps them all. And a string flag
 * given no value takes the next flag as one: a `bare` flag that stands last, or before another flag, takes its bare
 * value instead.
 */
export function readArgs(
  rawArgs: readonly string[],
  def: ArgsDef,
  opts: ReadOptions,
): Record<string, unknown> {
  const raw = withBareValues(rawArgs, def, opts.bare ?? {});
  const repeated = new Set(opts.repeated);
  const values: Record<string, string[]> = {};
  for (const t of optionTokens(raw, def)) if (repeated.has(t.key)) (values[t.key] ??= []).push(t.value ?? '');
  return { ...parseArgs([...raw], def), ...values };
}

/** A bare flag, as `--flag=<its bare value>`. */
function withBareValues(
  raw: readonly string[],
  def: ArgsDef,
  bare: Readonly<Record<string, string>>,
): readonly string[] {
  const out = [...raw];
  for (const t of optionTokens(raw, def)) {
    const value = bare[t.key];
    if (value !== undefined && !t.inline && (t.value === undefined || t.value.startsWith('-')))
      out[t.index] = `--${kebab(t.key)}=${value}`;
  }
  return out;
}

interface OptionToken {
  /** The flag's name in the command's args. */
  key: string;
  /** Where the flag is in the raw arguments. */
  index: number;
  value: string | undefined;
  /** The value was written `--flag=value`. */
  inline: boolean;
}

/** The flags of a command line, tokenized as citty's parser sees them: without its `--no-` negations. */
function optionTokens(raw: readonly string[], def: ArgsDef): OptionToken[] {
  const { options, keys } = optionsOf(def);
  const end = raw.indexOf('--');
  const kept = raw.flatMap((arg, i) => ((end === -1 || i < end) && arg.startsWith('--no-') ? [] : [i]));
  const { tokens } = tokenize({
    args: kept.map((i) => raw[i]!),
    options,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  return tokens.flatMap((t) => {
    const key = t.kind === 'option' ? keys.get(t.name) : undefined;
    if (t.kind !== 'option' || key === undefined) return [];
    return [{ key, index: kept[t.index]!, value: t.value, inline: t.inlineValue === true }];
  });
}

/** The options citty declares for a command's args: each name, its kebab- and camelCase forms and its aliases, typed. */
function optionsOf(def: ArgsDef): { options: ParseArgsOptionsConfig; keys: Map<string, string> } {
  const options: ParseArgsOptionsConfig = {};
  const keys = new Map<string, string>();
  for (const [key, arg] of Object.entries(def)) {
    if (arg.type === 'positional') continue;
    const type = arg.type === 'boolean' ? 'boolean' : 'string';
    const aliases = 'alias' in arg ? [arg.alias ?? []].flat() : [];
    for (const name of new Set([key, kebab(key), camel(key), ...aliases])) {
      options[name] = { type };
      keys.set(name, key);
    }
    const short = aliases.find((a) => a.length === 1);
    if (short !== undefined) options[key] = { type, short };
  }
  return { options, keys };
}

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const camel = (name: string): string => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** A flag given a value it does not take: the command prints the message and exits 2. */
export class FlagError extends Error {
  override name = 'FlagError';
}

/** `value` when it is one of `choices`; else a `FlagError` naming what `--<flag>` takes. */
export function oneOf<const T extends string>(flag: string, value: unknown, choices: readonly T[]): T {
  if (choices.some((c) => c === value)) return value as T;
  throw new FlagError(`--${flag} takes ${spoken(choices)}, not '${String(value)}'`);
}

/** A list as a sentence says it: `a, b or c`. */
export const spoken = (items: readonly string[]): string =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items.at(-1)}` : items.join('');

/** Where a command reports an error, and the environment that says how. */
export interface ErrorIo {
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
}

/**
 * The exit code of a command's body; 2 when it throws, with the error's message on stderr (its stack under
 * `SIMULCI_DEBUG=1`). citty would print the stack and exit 1, which `simulci test` uses for a failed case.
 */
export async function exitCodeOf(body: () => number | Promise<number>, io: ErrorIo): Promise<number> {
  try {
    return await body();
  } catch (e) {
    io.stderr(`${errorText(e, io.env.SIMULCI_DEBUG === '1')}\n`);
    return 2;
  }
}

/** A command's output and environment as a process has them, and the tokens it read, which it never prints. */
export interface ProcessIo extends ErrorIo {
  stdout: (text: string) => void;
  /** Filled as a command reads tokens: every write leaves them out. */
  secrets: string[];
}

export function processIo(): ProcessIo {
  const secrets: string[] = [];
  return {
    stdout: (t) => process.stdout.write(printable(t, secrets)),
    stderr: (t) => process.stderr.write(printable(t, secrets)),
    env: process.env,
    secrets,
  };
}

/**
 * Text as a terminal or a runner's log may show it: without the tokens a command read (the longest first, so one inside
 * another leaves nothing), and with control characters other than a newline and a tab escaped as `\\uXXXX`. Remote
 * workflows name jobs and steps, and an escape sequence there could rewrite a terminal.
 */
export function printable(text: string, secrets: readonly string[] = []): string {
  const hidden = [...secrets]
    .filter((s) => s.length >= 8)
    .sort((a, b) => b.length - a.length)
    .reduce((out, s) => out.split(s).join('***'), text);
  let out = '';
  for (const c of hidden) {
    const code = c.charCodeAt(0);
    const control = (code < 0x20 && c !== '\n' && c !== '\t') || (code >= 0x7f && code < 0xa0);
    out += control ? `\\u${code.toString(16).padStart(4, '0')}` : c;
  }
  return out;
}

/**
 * Text a runner's log reads as text: a line that would start with `::` (a workflow command, which GitHub reads on stdout
 * and stderr after any indentation) has its first colon escaped. A remote workflow's job or step name may hold a newline
 * followed by `::stop-commands::` or `::error::`. Annotations are written apart, as the commands they are.
 */
export const withoutCommands = (text: string): string => text.replace(/^(\s*)::/gm, '$1\\u003a:');

function errorText(e: unknown, stack: boolean): string {
  if (!(e instanceof Error)) return String(e);
  return stack && e.stack !== undefined ? e.stack : e.message;
}

/** A flag's values as a list: none, one, or every one it was given. */
export const values = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/** The `--assume` entries and the `--assume-file` list; an `AssumeError` when one does not parse or the file cannot be read. */
export function assumeOf(assume: string | string[] | undefined, file: string | undefined): AssumeEntry[] {
  return parseAssume(values(assume), file === undefined ? undefined : readAssumeFile(file));
}

function readAssumeFile(file: string): string {
  try {
    return readFileSync(resolve(file), 'utf8');
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (e as Error).message;
    throw new AssumeError(`--assume-file ${file}: ${why}`);
  }
}
