import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDeterministicGates } from '../src/gates.js';

function mkFixture(scripts = {}, extraFiles = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-gates-test-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });

  const pkg = {
    name: 'qg-gates-fixture',
    private: true,
    type: 'module',
    scripts,
  };
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  return dir;
}

function defaultConfig(overrides = {}) {
  return {
    commands: {},
    lighthouse: { thresholds: { performance: 0.8 } },
    ...overrides,
  };
}

test('lint gate passes when npm script exits 0', () => {
  const cwd = mkFixture({ lint: 'exit 0', typecheck: 'exit 0', lighthouse: 'exit 0' });
  const result = runDeterministicGates({
    mode: 'canary',
    cwd,
    config: defaultConfig(),
    changedFiles: ['app/page.tsx'],
  });

  const lintGate = result.gates.find((g) => g.name === 'lint');
  assert.ok(lintGate);
  assert.equal(lintGate.status, 'pass');
});

test('lint gate fails when npm script exits non-zero', () => {
  const cwd = mkFixture({
    lint: 'echo "lint error" >&2 && exit 1',
    typecheck: 'exit 0',
    lighthouse: 'exit 0',
  });
  const result = runDeterministicGates({
    mode: 'canary',
    cwd,
    config: defaultConfig(),
    changedFiles: ['app/page.tsx'],
  });

  const lintGate = result.gates.find((g) => g.name === 'lint');
  assert.equal(lintGate.status, 'fail');
  const finding = result.findings.find((f) => f.gate === 'lint');
  assert.ok(finding);
  assert.equal(finding.status, 'fail');
});

test('build gate is skipped in canary mode', () => {
  const cwd = mkFixture({
    lint: 'exit 0',
    typecheck: 'exit 0',
    build: 'exit 1',
    lighthouse: 'exit 0',
  });
  const result = runDeterministicGates({
    mode: 'canary',
    cwd,
    config: defaultConfig(),
    changedFiles: [],
  });

  const buildGate = result.gates.find((g) => g.name === 'build');
  assert.equal(buildGate.status, 'skipped');
});

test('build gate runs in full mode', () => {
  const cwd = mkFixture({
    lint: 'exit 0',
    typecheck: 'exit 0',
    build: 'exit 0',
    lighthouse: 'exit 0',
  });
  const result = runDeterministicGates({
    mode: 'full',
    cwd,
    config: defaultConfig(),
    changedFiles: [],
  });

  const buildGate = result.gates.find((g) => g.name === 'build');
  assert.equal(buildGate.status, 'pass');
});

test('missing command produces finding', () => {
  const cwd = mkFixture({ typecheck: 'exit 0', lighthouse: 'exit 0' });
  const result = runDeterministicGates({
    mode: 'canary',
    cwd,
    config: defaultConfig(),
    changedFiles: ['app/page.tsx'],
  });

  const lintGate = result.gates.find((g) => g.name === 'lint');
  assert.equal(lintGate.status, 'fail');
  const finding = result.findings.find((f) => f.id === 'lint_missing_command');
  assert.ok(finding);
  assert.equal(finding.actual, 'missing');
});

test('config command overrides package.json script', () => {
  const cwd = mkFixture({
    lint: 'exit 1',
    typecheck: 'exit 0',
    lighthouse: 'exit 0',
  });
  const config = defaultConfig({ commands: { lint: 'exit 0' } });
  const result = runDeterministicGates({
    mode: 'canary',
    cwd,
    config,
    changedFiles: [],
  });

  const lintGate = result.gates.find((g) => g.name === 'lint');
  assert.equal(lintGate.status, 'pass');
});

test('typecheck fallback to npx tsc --noEmit when no script', () => {
  const cwd = mkFixture({
    lint: 'exit 0',
    lighthouse: 'exit 0',
  });
  const result = runDeterministicGates({
    mode: 'canary',
    cwd,
    config: defaultConfig(),
    changedFiles: [],
  });

  const tcGate = result.gates.find((g) => g.name === 'typecheck');
  assert.ok(tcGate);
  assert.ok(['pass', 'fail'].includes(tcGate.status));
  const trace = result.traces.find((t) => t.command === 'npx tsc --noEmit');
  assert.ok(trace);
});

test('lighthouse fallback to exit code finding when no assertion-results', () => {
  const cwd = mkFixture({
    lint: 'exit 0',
    typecheck: 'exit 0',
    lighthouse: 'echo "lh error" >&2 && exit 1',
  });
  // No .lighthouseci/assertion-results.json created
  const result = runDeterministicGates({
    mode: 'canary',
    cwd,
    config: defaultConfig(),
    changedFiles: [],
  });

  const lhGate = result.gates.find((g) => g.name === 'lighthouse');
  assert.equal(lhGate.status, 'fail');
  const finding = result.findings.find((f) => f.gate === 'lighthouse');
  assert.ok(finding);
  assert.ok(finding.id.startsWith('lighthouse_exit_'));
  assert.equal(finding.actual, 1);
});

test('traces include all executed commands', () => {
  const cwd = mkFixture({
    lint: 'exit 0',
    typecheck: 'exit 0',
    lighthouse: 'exit 0',
  });
  const result = runDeterministicGates({
    mode: 'canary',
    cwd,
    config: defaultConfig(),
    changedFiles: [],
  });

  assert.ok(result.traces.length >= 3);
  for (const trace of result.traces) {
    assert.ok(typeof trace.command === 'string');
    assert.ok(typeof trace.exit_code === 'number');
    assert.ok(typeof trace.duration_ms === 'number');
  }
});
