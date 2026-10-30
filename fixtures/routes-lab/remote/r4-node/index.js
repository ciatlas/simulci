// Case R4: writes one declared and one undeclared output; the caller reads both.
const { appendFileSync } = require('node:fs');

appendFileSync(process.env.GITHUB_OUTPUT, 'declared=d\nundeclared=u\n');
console.log('probe: r4-node=ran');
