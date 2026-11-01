#!/usr/bin/env node
import { VERSION } from '@simulci/engine';
import { defineCommand, runMain } from 'citty';
import { modelsCommand } from './models';
import { planCommand } from './plan';
import { remotesCommand } from './remotes';
import { testCommand } from './test';

const main = defineCommand({
  meta: {
    name: 'simulci',
    version: VERSION,
    description: 'Static simulator and test framework for GitHub Actions',
  },
  subCommands: { plan: planCommand, test: testCommand, remotes: remotesCommand, models: modelsCommand },
});

void runMain(main);
