import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, '..', 'src', 'cli.js');

function runCli(args, options = {}) {
  const result = spawnSync('node', [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    code: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

test('--help exits 0 and shows usage', () => {
  const result = runCli(['--help']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('quick-gate run'));
  assert.ok(result.stdout.includes('--deterministic-only'));
});

test('-h exits 0', () => {
  const result = runCli(['-h']);
  assert.equal(result.code, 0);
});

test('no args exits 0 and shows usage', () => {
  const result = runCli([]);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('Commands'));
});

test('unknown command exits 1', () => {
  const result = runCli(['bogus']);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('Unknown command'));
});

test('run without --mode exits 1', () => {
  const result = runCli(['run', '--changed-files', '/tmp/test.txt']);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('--mode'));
});

test('run without --changed-files exits 1', () => {
  const result = runCli(['run', '--mode', 'canary']);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('--changed-files'));
});

test('run with invalid mode exits 1', () => {
  const result = runCli(['run', '--mode', 'invalid', '--changed-files', '/tmp/test.txt']);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('--mode canary|full'));
});

test('summarize without --input exits 1', () => {
  const result = runCli(['summarize']);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('--input'));
});

test('repair without --input exits 1', () => {
  const result = runCli(['repair']);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('--input'));
});
