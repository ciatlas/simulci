import { z } from 'zod';
import { RemotesLockSchema } from './remotes/lock';
import { ScenarioInputSchema } from './scenario';
import { TestFileSchema } from './test/schema';
import type { SCHEMA_VERSIONS } from './version';
import { schemaUrl } from './version';

/** The JSON schemas of the documents authors write, published at `schemaUrl` for editors and the `$schema` keys. */
export function jsonSchemas(): Partial<Record<keyof typeof SCHEMA_VERSIONS, Record<string, unknown>>> {
  return {
    scenario: {
      $id: schemaUrl('scenario'),
      title: 'simulci scenario',
      description: 'The facts about one run: event, ref, inputs, variables, changed files, actor.',
      ...z.toJSONSchema(ScenarioInputSchema),
    },
    test: {
      $id: schemaUrl('test'),
      title: 'simulci route test',
      description:
        'One workflow, scenario defaults, and cases: a scenario each, and what runs, skips, and why.',
      ...z.toJSONSchema(TestFileSchema, { io: 'input', unrepresentable: 'any' }),
    },
    remotesLock: {
      $id: schemaUrl('remotesLock'),
      title: 'simulci remotes lockfile',
      description:
        'The commit each remote workflow and action a repository uses resolved to, and a digest of the file read there.',
      ...z.toJSONSchema(RemotesLockSchema, { io: 'input' }),
    },
  };
}
