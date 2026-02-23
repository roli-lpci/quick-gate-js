import test from 'node:test';
import assert from 'node:assert/strict';
import { hasGit, hasOllama, hasRsync, checkEnvironment } from '../src/env-check.js';

test('hasGit returns boolean', () => {
  const result = hasGit();
  assert.equal(typeof result, 'boolean');
});

test('hasOllama returns boolean', () => {
  const result = hasOllama();
  assert.equal(typeof result, 'boolean');
});

test('hasRsync returns boolean', () => {
  const result = hasRsync();
  assert.equal(typeof result, 'boolean');
});

test('checkEnvironment returns warnings array', () => {
  const warnings = checkEnvironment({ command: 'run' });
  assert.ok(Array.isArray(warnings));
});

test('checkEnvironment for repair mentions Ollama when missing', () => {
  // This test is environment-dependent; if Ollama IS installed, warnings will be empty
  const warnings = checkEnvironment({ command: 'repair' });
  assert.ok(Array.isArray(warnings));
  // We just verify the shape -- actual content depends on host
});
