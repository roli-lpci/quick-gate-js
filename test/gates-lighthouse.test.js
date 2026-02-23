import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDeterministicGates } from '../src/gates.js';

function mkFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-gates-lh-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.lighthouseci'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'qg-gates-lh-fixture',
        private: true,
        type: 'module',
        scripts: {
          lint: 'node scripts/check.js lint',
          typecheck: 'node scripts/check.js typecheck',
          lighthouse: 'node scripts/check.js lighthouse',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  fs.writeFileSync(
    path.join(dir, 'scripts/check.js'),
    `const gate = process.argv[2];
if (gate === 'lighthouse') {
  console.error('lh failed');
  process.exit(1);
}
process.exit(0);
`,
    'utf8',
  );

  fs.writeFileSync(
    path.join(dir, '.lighthouseci', 'assertion-results.json'),
    `${JSON.stringify(
      [
        {
          passed: false,
          url: 'http://localhost:3000/about?utm=1',
          assertion: 'categories:performance',
          numericValue: 0.72,
          message: 'Performance score below threshold',
          level: 'error',
          auditProperty: 'score',
        },
      ],
      null,
      2,
    )}\n`,
    'utf8',
  );

  return dir;
}

test('lighthouse parser extracts route + threshold attribution', () => {
  const cwd = mkFixture();
  const config = {
    commands: {},
    lighthouse: {
      thresholds: {
        performance: 0.8,
      },
    },
  };

  const result = runDeterministicGates({
    mode: 'canary',
    cwd,
    config,
    changedFiles: ['app/about/page.tsx'],
  });

  const lhFinding = result.findings.find((f) => f.gate === 'lighthouse');
  assert.ok(lhFinding);
  assert.equal(lhFinding.route, '/about');
  assert.equal(lhFinding.metric, 'categories:performance');
  assert.equal(lhFinding.threshold, 0.8);
  assert.equal(lhFinding.raw.threshold_source, 'config_category:performance');
});
