#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const cli = resolve(process.cwd(), 'dist', 'cli.js');
const child = spawn(process.execPath, [cli, 'loop', ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

child.once('error', (error) => {
  process.stderr.write(`Pi live acceptance could not start OpenSquid: ${error.message}\n`);
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  if (signal !== null) {
    process.stderr.write(`OpenSquid loop ended by ${signal}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
