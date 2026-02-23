import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { loadChangedFiles } from '../src/fs-utils.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qg-config-test-'));
}

test('loadConfig returns defaults when no config file exists', () => {
  const dir = tmpDir();
  const config = loadConfig(dir);
  assert.equal(config.source, 'defaults');
  assert.equal(config.policy.maxAttempts, 3);
  assert.equal(config.policy.maxPatchLines, 150);
  assert.equal(config.lighthouse.thresholds.performance, 0.8);
});

test('loadConfig merges user config with defaults', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'quick-gate.config.json'),
    JSON.stringify({
      policy: { maxAttempts: 5 },
      commands: { lint: 'custom-lint' },
      lighthouse: { thresholds: { performance: 0.9 } },
    }),
  );
  const config = loadConfig(dir);
  assert.equal(config.policy.maxAttempts, 5);
  assert.equal(config.policy.maxPatchLines, 150);
  assert.equal(config.commands.lint, 'custom-lint');
  assert.equal(config.lighthouse.thresholds.performance, 0.9);
  assert.equal(config.lighthouse.thresholds.accessibility, 0.8);
});

test('loadChangedFiles parses newline-delimited file', () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'changed.txt');
  fs.writeFileSync(filePath, 'src/app.ts\nlib/utils.ts\n');
  const files = loadChangedFiles(filePath);
  assert.deepEqual(files, ['src/app.ts', 'lib/utils.ts']);
});

test('loadChangedFiles parses JSON array', () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'changed.json');
  fs.writeFileSync(filePath, '["src/app.ts", "lib/utils.ts"]');
  const files = loadChangedFiles(filePath);
  assert.deepEqual(files, ['src/app.ts', 'lib/utils.ts']);
});

test('loadChangedFiles returns empty array for empty file', () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'empty.txt');
  fs.writeFileSync(filePath, '');
  const files = loadChangedFiles(filePath);
  assert.deepEqual(files, []);
});

test('loadChangedFiles strips blank lines', () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'changed.txt');
  fs.writeFileSync(filePath, 'a.ts\n\n  \nb.ts\n');
  const files = loadChangedFiles(filePath);
  assert.deepEqual(files, ['a.ts', 'b.ts']);
});
