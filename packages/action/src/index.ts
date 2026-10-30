import { randomUUID } from 'node:crypto';
import * as core from '@actions/core';
import { run, withoutCommands } from './main';
import { printable } from './remotes';

// Masked before anything is logged, so a message that ever held one prints *** instead.
for (const name of ['token', 'github-com-token']) {
  const token = core.getInput(name).trim();
  if (token) core.setSecret(token);
}

// A library's warning goes to stderr, outside the guarded log, and may quote another repository's text (yaml's do):
// it is logged like any other text instead.
process.emitWarning = (warning: string | Error) =>
  core.info(withoutCommands(printable(String(warning)), randomUUID()));

try {
  await run({
    input: (name) => core.getInput(name).trim(),
    setOutput: (name, value) => core.setOutput(name, value),
    annotate: (a) => {
      const props = { file: a.file, startLine: a.line, startColumn: a.col, title: a.title };
      if (a.level === 'error') core.error(a.message, props);
      else core.notice(a.message, props);
    },
    summary: async (markdown) => {
      core.summary.addRaw(markdown, true);
      await core.summary.write();
    },
    log: (text) => core.info(withoutCommands(text, randomUUID())),
    warn: (message) => core.warning(message),
    fail: (message) => core.setFailed(message),
    workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    env: process.env,
  });
} catch (e) {
  core.setFailed(e instanceof Error ? e.message : String(e));
}
