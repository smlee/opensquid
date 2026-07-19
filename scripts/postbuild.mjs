import { chmod, copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const executables = [
  'dist/cli.js',
  'dist/mcp/server.js',
  'dist/mcp/chat-bridge-server.js',
  'dist/runtime/hooks/post-tool-use.js',
  'dist/runtime/hooks/pre-tool-use.js',
  'dist/runtime/hooks/session-end.js',
  'dist/runtime/hooks/session-start.js',
  'dist/runtime/hooks/stop.js',
  'dist/runtime/hooks/user-prompt-submit.js',
];
if (process.platform !== 'win32') {
  await Promise.all(executables.map((path) => chmod(path, 0o755)));
}

// TypeScript does not prune outputs for deleted sources. Remove retired hierarchy artifacts explicitly so a
// normal incremental build cannot package the former nested Pi/executor architecture.
const retiredStems = [
  'dist/integrations/pi/pi_subagent_launcher',
  'dist/integrations/pi/spawn_subagent',
  'dist/integrations/pi/subagent_usage',
  'dist/runtime/loop/driver',
  'dist/runtime/registry/executor_registry',
  'dist/runtime/exe/transitions',
  'dist/runtime/subagents/executor_loop',
  'dist/runtime/subagents/process_control',
  'dist/runtime/subagents/process_resume',
  'dist/runtime/subagents/role_markdown',
  'dist/runtime/subagents/roles',
  'dist/runtime/subagents/service',
  'dist/runtime/subagents/windows_job',
  'dist/setup/wizard/pi-role-writer',
];
await Promise.all(
  retiredStems.flatMap((stem) =>
    ['.js', '.js.map', '.d.ts', '.d.ts.map'].map((suffix) => rm(stem + suffix, { force: true })),
  ),
);
await Promise.all(
  ['windows_job_broker.ps1', 'windows_job_control.ps1'].map((file) =>
    rm(join('dist', 'runtime', 'subagents', file), { force: true }),
  ),
);

const target = join('dist', 'runtime', 'processes');
await mkdir(target, { recursive: true });
for (const file of ['windows_job_broker.ps1', 'windows_job_control.ps1']) {
  await copyFile(join('src', 'runtime', 'processes', file), join(target, file));
}
