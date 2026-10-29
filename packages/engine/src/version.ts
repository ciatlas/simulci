/** The simulci version. release-please updates it with every release. */
export const VERSION = '0.4.0'; // x-release-please-version

/** The schema version of every JSON document the engine emits or reads. A breaking change bumps it. */
export const SCHEMA_VERSIONS = { scenario: 1, runPlan: 1, test: 1, config: 1 } as const;

/** Where the JSON schema of a document is published (the `$schema` of emitted documents). */
export const schemaUrl = (name: keyof typeof SCHEMA_VERSIONS): string =>
  `https://ciatlas.github.io/simulci/schemas/${name}/v${SCHEMA_VERSIONS[name]}.json`;
