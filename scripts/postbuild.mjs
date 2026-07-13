import { chmod, copyFile, mkdir } from 'node:fs/promises';
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

const target = join('dist', 'runtime', 'subagents');
await mkdir(target, { recursive: true });
for (const file of ['windows_job_broker.ps1', 'windows_job_control.ps1']) {
  await copyFile(join('src', 'runtime', 'subagents', file), join(target, file));
}
