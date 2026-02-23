import { spawnSync } from 'node:child_process';

export function runCommand(command, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, {
    shell: true,
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
    timeout: options.timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });

  return {
    command,
    cwd: options.cwd || process.cwd(),
    started_at: new Date(startedAt).toISOString(),
    duration_ms: Date.now() - startedAt,
    exit_code: typeof result.status === 'number' ? result.status : 1,
    timed_out: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}
