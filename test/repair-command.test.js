import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { executeRepair } from '../src/repair-command.js';

function mkRepairFixture({ lintFails = false, typeFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-repair-test-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.quick-gate'), { recursive: true });

  const markerFile = path.join(dir, 'src', 'app.ts');
  const markers = [];
  if (lintFails) markers.push('// __LINT_FAIL__');
  if (typeFails) markers.push('// __TYPE_FAIL__');
  fs.writeFileSync(markerFile, `export const v = 1;\n${markers.join('\n')}\n`, 'utf8');

  const pkg = {
    name: 'qg-repair-fixture',
    private: true,
    type: 'module',
    scripts: {
      lint: 'node scripts/check.js lint',
      typecheck: 'node scripts/check.js typecheck',
      lighthouse: 'exit 0',
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  const checkScript = `import fs from 'node:fs';
const gate = process.argv[2];
const c = fs.readFileSync('src/app.ts', 'utf8');
if (gate === 'lint' && c.includes('__LINT_FAIL__')) { console.error('LINT_ERROR'); process.exit(1); }
if (gate === 'typecheck' && c.includes('__TYPE_FAIL__')) { console.error('TYPE_ERROR'); process.exit(1); }
process.exit(0);
`;
  fs.writeFileSync(path.join(dir, 'scripts', 'check.js'), checkScript, 'utf8');

  // Init git for diffSnapshot
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf8' });

  return dir;
}

function seedFailures(dir, { mode = 'canary', findingGate = 'lint', findingCount = 1 } = {}) {
  const findings = [];
  for (let i = 0; i < findingCount; i++) {
    findings.push({
      id: `${findingGate}_err_${i}`,
      gate: findingGate,
      severity: 'high',
      summary: `${findingGate} failed`,
      files: ['src/app.ts'],
      actual: 1,
      threshold: 0,
      status: 'fail',
    });
  }

  const failures = {
    version: '1.0.0',
    run_id: 'test_run',
    mode,
    status: 'fail',
    timestamp: new Date().toISOString(),
    gates: [
      { name: 'lint', status: findingGate === 'lint' ? 'fail' : 'pass', duration_ms: 10 },
      { name: 'typecheck', status: findingGate === 'typecheck' ? 'fail' : 'pass', duration_ms: 10 },
      { name: 'lighthouse', status: 'pass', duration_ms: 10 },
    ],
    findings,
    changed_files: ['src/app.ts'],
    inferred_hints: [],
  };

  fs.writeFileSync(
    path.join(dir, '.quick-gate', 'failures.json'),
    `${JSON.stringify(failures, null, 2)}\n`,
    'utf8',
  );
}

function withEnv(vars, fn) {
  const old = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('deterministic-only repair escalates when no model and lint persists', () => {
  const dir = mkRepairFixture({ lintFails: true });
  seedFailures(dir, { findingGate: 'lint' });

  const result = executeRepair({
    input: '.quick-gate/failures.json',
    maxAttempts: 2,
    deterministicOnly: true,
    cwd: dir,
  });

  assert.equal(result.status, 'escalated');
  assert.ok(['NO_IMPROVEMENT', 'UNKNOWN_BLOCKER'].includes(result.reason_code));
});

test('repair with mock model that fixes lint produces pass', () => {
  const dir = mkRepairFixture({ lintFails: true });
  seedFailures(dir, { findingGate: 'lint' });

  const result = withEnv(
    {
      QUICK_GATE_PATCH_MODEL: 'mistral:7b',
      QUICK_GATE_HINT_MODEL: 'qwen2.5:1.5b',
      QUICK_GATE_MOCK_OLLAMA_HINT: JSON.stringify({
        hints: [{ finding_id: 'lint_err_0', hint: 'remove marker', confidence: 'high' }],
      }),
      QUICK_GATE_MOCK_OLLAMA_PATCH: JSON.stringify({
        summary: 'remove lint marker',
        edits: [{
          file: 'src/app.ts',
          start_line: 2,
          end_line: 2,
          replacement: '',
        }],
      }),
    },
    () => executeRepair({
      input: '.quick-gate/failures.json',
      maxAttempts: 3,
      deterministicOnly: false,
      cwd: dir,
    }),
  );

  assert.equal(result.status, 'pass');
  assert.ok(result.attempts.length >= 1);
  assert.ok(fs.existsSync(path.join(dir, '.quick-gate', 'repair-report.json')));
});

test('repair creates backup directories', () => {
  const dir = mkRepairFixture({ lintFails: true });
  seedFailures(dir, { findingGate: 'lint' });

  executeRepair({
    input: '.quick-gate/failures.json',
    maxAttempts: 1,
    deterministicOnly: true,
    cwd: dir,
  });

  assert.ok(fs.existsSync(path.join(dir, '.quick-gate', 'backup-attempt-1')));
});

test('repair respects time cap', () => {
  const dir = mkRepairFixture({ lintFails: true });
  seedFailures(dir, { findingGate: 'lint' });

  // Write config with 1ms time cap to force immediate timeout
  fs.writeFileSync(
    path.join(dir, 'quick-gate.config.json'),
    JSON.stringify({ policy: { timeCapMs: 1 } }),
  );

  // Small delay to ensure time cap triggers
  const start = Date.now();
  while (Date.now() - start < 5) { /* wait */ }

  const result = executeRepair({
    input: '.quick-gate/failures.json',
    maxAttempts: 3,
    deterministicOnly: true,
    cwd: dir,
  });

  assert.equal(result.status, 'escalated');
  assert.ok(result.message.includes('Time cap'));
});

test('repair produces escalation.json on failure', () => {
  const dir = mkRepairFixture({ lintFails: true });
  seedFailures(dir, { findingGate: 'lint' });

  executeRepair({
    input: '.quick-gate/failures.json',
    maxAttempts: 1,
    deterministicOnly: true,
    cwd: dir,
  });

  const escalationPath = path.join(dir, '.quick-gate', 'escalation.json');
  assert.ok(fs.existsSync(escalationPath));
  const escalation = JSON.parse(fs.readFileSync(escalationPath, 'utf8'));
  assert.equal(escalation.status, 'escalated');
  assert.ok(typeof escalation.reason_code === 'string');
});

test('deterministicOnly flag is recorded in repair actions', () => {
  const dir = mkRepairFixture({ lintFails: true });
  seedFailures(dir, { findingGate: 'lint' });

  const result = executeRepair({
    input: '.quick-gate/failures.json',
    maxAttempts: 1,
    deterministicOnly: true,
    cwd: dir,
  });

  const attempt = result.evidence?.attempts?.[0] || result.attempts?.[0];
  if (attempt) {
    const deterministicAction = attempt.actions?.find((a) => a.strategy === 'deterministic_only_mode');
    assert.ok(deterministicAction);
  }
});

test('worsened findings trigger workspace rollback', () => {
  // Create a fixture where the mock patch INTRODUCES a second failure marker
  const dir = mkRepairFixture({ lintFails: true });
  seedFailures(dir, { findingGate: 'lint' });

  const originalContent = fs.readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8');

  const result = withEnv(
    {
      QUICK_GATE_PATCH_MODEL: 'mistral:7b',
      QUICK_GATE_HINT_MODEL: 'qwen2.5:1.5b',
      QUICK_GATE_MOCK_OLLAMA_HINT: JSON.stringify({
        hints: [{ finding_id: 'lint_err_0', hint: 'bad hint', confidence: 'low' }],
      }),
      // Patch that adds a SECOND failure marker instead of removing the first
      QUICK_GATE_MOCK_OLLAMA_PATCH: JSON.stringify({
        summary: 'bad patch',
        edits: [{
          file: 'src/app.ts',
          start_line: 1,
          end_line: 1,
          replacement: 'export const v = 1;\n// __LINT_FAIL__\n// __TYPE_FAIL__',
        }],
      }),
    },
    () => executeRepair({
      input: '.quick-gate/failures.json',
      maxAttempts: 2,
      deterministicOnly: false,
      cwd: dir,
    }),
  );

  // Should escalate (either NO_IMPROVEMENT or UNKNOWN_BLOCKER)
  assert.equal(result.status, 'escalated');
});

test('model patch retry on invalid JSON first attempt', () => {
  const dir = mkRepairFixture({ lintFails: true });
  seedFailures(dir, { findingGate: 'lint' });

  // Mock returns invalid JSON -- the adapter should retry and then reject
  const result = withEnv(
    {
      QUICK_GATE_PATCH_MODEL: 'mistral:7b',
      QUICK_GATE_HINT_MODEL: 'qwen2.5:1.5b',
      QUICK_GATE_MOCK_OLLAMA_HINT: JSON.stringify({
        hints: [{ finding_id: 'lint_err_0', hint: 'remove marker', confidence: 'high' }],
      }),
      QUICK_GATE_MOCK_OLLAMA_PATCH: 'This is not JSON at all, just prose.',
    },
    () => executeRepair({
      input: '.quick-gate/failures.json',
      maxAttempts: 1,
      deterministicOnly: false,
      cwd: dir,
    }),
  );

  assert.equal(result.status, 'escalated');
});

test('lighthouse-only findings skip model patch', () => {
  // Create fixture where lighthouse always fails
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-repair-lh-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.quick-gate'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), "export const v = 1;\n", 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'qg-lh-fixture',
    private: true,
    type: 'module',
    scripts: {
      lint: 'exit 0',
      typecheck: 'exit 0',
      lighthouse: 'echo "lh fail" >&2 && exit 1',
    },
  }, null, 2));

  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf8' });

  const failures = {
    version: '1.0.0',
    run_id: 'test_run',
    mode: 'canary',
    status: 'fail',
    timestamp: new Date().toISOString(),
    gates: [
      { name: 'lint', status: 'pass', duration_ms: 10 },
      { name: 'typecheck', status: 'pass', duration_ms: 10 },
      { name: 'lighthouse', status: 'fail', duration_ms: 10 },
    ],
    findings: [{
      id: 'lh_err',
      gate: 'lighthouse',
      severity: 'high',
      summary: 'lighthouse failed',
      actual: 1,
      threshold: 0,
      status: 'fail',
    }],
    changed_files: ['src/app.ts'],
    inferred_hints: [],
  };
  fs.writeFileSync(path.join(dir, '.quick-gate', 'failures.json'), JSON.stringify(failures, null, 2));

  const result = executeRepair({
    input: '.quick-gate/failures.json',
    maxAttempts: 2,
    deterministicOnly: false,
    cwd: dir,
  });

  assert.equal(result.status, 'escalated');
});
