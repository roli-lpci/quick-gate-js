import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getModelRoutingPolicy, runHintModel, runPatchModel } from '../src/model-adapter.js';

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

function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-model-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/app.ts'), "export const v = 'x';\n// __TYPE_FAIL__\n", 'utf8');
  return dir;
}

function failures() {
  return {
    changed_files: ['src/app.ts'],
    findings: [
      {
        id: 'type_err',
        gate: 'typecheck',
        summary: 'typecheck failed',
        files: ['src/app.ts'],
        raw: { stderr_excerpt: 'remove __TYPE_FAIL__ marker' },
      },
    ],
  };
}

test('routing defaults to qwen hint + mistral patch', () => {
  const policy = withEnv({ QUICK_GATE_HINT_MODEL: null, QUICK_GATE_PATCH_MODEL: null }, () => getModelRoutingPolicy());
  assert.equal(policy.hintModel, 'qwen2.5:1.5b');
  assert.equal(policy.patchModel, 'mistral:7b');
});

test('hint model parses JSON hints from mock output', () => {
  const result = withEnv(
    {
      QUICK_GATE_MOCK_OLLAMA_HINT: JSON.stringify({ hints: [{ finding_id: 'type_err', hint: 'remove marker', confidence: 'high' }] }),
      QUICK_GATE_HINT_MODEL: 'qwen2.5:1.5b',
    },
    () => runHintModel({ cwd: process.cwd(), failures: failures(), policy: getModelRoutingPolicy() }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.hints.length, 1);
});

test('patch model applies valid JSON edit plan', () => {
  const dir = fixtureDir();
  const result = withEnv(
    {
      QUICK_GATE_PATCH_MODEL: 'mistral:7b',
      QUICK_GATE_MOCK_OLLAMA_PATCH: JSON.stringify({
        summary: 'remove failure marker',
        edits: [
          {
            file: 'src/app.ts',
            start_line: 2,
            end_line: 2,
            replacement: '',
          },
        ],
      }),
    },
    () => runPatchModel({ cwd: dir, failures: failures(), policy: getModelRoutingPolicy(), maxPatchLines: 20 }),
  );

  assert.equal(result.accepted, true);
  const updated = fs.readFileSync(path.join(dir, 'src/app.ts'), 'utf8');
  assert.equal(updated.includes('__TYPE_FAIL__'), false);
});

test('patch model rejects low-score plan on unrelated file', () => {
  const dir = fixtureDir();
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n', 'utf8');

  const result = withEnv(
    {
      QUICK_GATE_PATCH_MODEL: 'mistral:7b',
      QUICK_GATE_MOCK_OLLAMA_PATCH: JSON.stringify({
        summary: 'edit unrelated',
        edits: [
          {
            file: 'README.md',
            start_line: 1,
            end_line: 1,
            replacement: 'y',
          },
        ],
      }),
    },
    () => runPatchModel({ cwd: dir, failures: failures(), policy: getModelRoutingPolicy(), maxPatchLines: 20 }),
  );

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'file_out_of_scope');
});

test('hint-only model is blocked from patching', () => {
  const dir = fixtureDir();
  const result = withEnv(
    {
      QUICK_GATE_PATCH_MODEL: 'qwen2.5:1.5b',
      QUICK_GATE_MOCK_OLLAMA_PATCH: JSON.stringify({ summary: 'noop', edits: [] }),
    },
    () => runPatchModel({ cwd: dir, failures: failures(), policy: getModelRoutingPolicy(), maxPatchLines: 20 }),
  );

  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'patch_model_is_hint_only');
});
