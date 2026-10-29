// Writes fixtures/routes-lab/accuracy.json: of the outcomes the routes lab observed on GitHub, how many the engine
// predicts exactly, as "might" (naming the unknown) and wrongly, given which scripted steps failed. CI checks that the
// file is committed and current; packages/engine/test/lab.ts says what is compared and how.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { measure } from '../packages/engine/test/lab';

const file = join(import.meta.dirname, '../fixtures/routes-lab/accuracy.json');
const { accuracy, wrong } = measure();
writeFileSync(file, `${JSON.stringify(accuracy, null, 2)}\n`);
console.log(`wrote ${file}`);
for (const line of wrong) console.error(`wrong: ${line}`);
