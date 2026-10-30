// Writes fixtures/routes-lab/accuracy.json: of the outcomes the routes lab observed on GitHub, how many the engine
// predicts exactly, as "might" (naming the unknown) and wrongly, given which scripted steps failed. The headline counts
// are the status cases; `remote` grades the remote cases (R1-R10) apart until they have no wrong prediction. CI checks
// that the file is committed and current; packages/engine/test/lab.ts and lab-remote.ts say what is compared and how.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { measure } from '../packages/engine/test/lab';
import { measureRemote } from '../packages/engine/test/lab-remote';

const file = join(import.meta.dirname, '../fixtures/routes-lab/accuracy.json');
const status = measure();
const remote = measureRemote();
writeFileSync(file, `${JSON.stringify({ ...status.accuracy, remote: remote.accuracy }, null, 2)}\n`);
console.log(`wrote ${file}`);
for (const line of status.wrong) console.error(`wrong: ${line}`);
for (const line of remote.wrong) console.error(`wrong (remote): ${line}`);
