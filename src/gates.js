import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './exec.js';

function packageScripts(cwd) {
  const packagePath = path.join(cwd, 'package.json');
  if (!fs.existsSync(packagePath)) {
    throw new Error(`No package.json found in ${cwd}`);
  }
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  return pkg.scripts || {};
}

function resolveGateCommand(gate, scripts, configCommands) {
  if (configCommands[gate]) {
    return configCommands[gate];
  }
  if (gate === 'typecheck') {
    if (scripts.typecheck) return 'npm run typecheck';
    return 'npx tsc --noEmit';
  }
  if (scripts[gate]) {
    return `npm run ${gate}`;
  }
  if (gate === 'lighthouse') {
    if (scripts.lighthouse) return 'npm run lighthouse';
    if (scripts['ci:lighthouse']) return 'npm run ci:lighthouse';
    if (scripts.lhci) return 'npm run lhci';
    return 'npx lhci autorun --upload.target=filesystem --upload.outputDir=.quick-gate/lhci';
  }
  return null;
}

function parseLighthouseFindings(cwd, thresholds) {
  const assertionResultsPath = path.join(cwd, '.lighthouseci', 'assertion-results.json');
  if (!fs.existsSync(assertionResultsPath)) {
    return [];
  }

  const data = JSON.parse(fs.readFileSync(assertionResultsPath, 'utf8'));
  const findings = [];

  const metricThresholds = thresholds || {};
  const routePath = (rawUrl) => {
    if (!rawUrl) return '/';
    try {
      const u = new URL(rawUrl);
      return u.pathname || '/';
    } catch {
      return String(rawUrl);
    }
  };

  const thresholdForAssertion = (row) => {
    if (typeof row.expected === 'number' || typeof row.expected === 'string') {
      return {
        value: row.expected,
        source: 'assertion_expected',
      };
    }

    const assertion = String(row.assertion || '');
    const parts = assertion.split(':');
    if (parts.length === 2 && parts[0] === 'categories' && metricThresholds[parts[1]] !== undefined) {
      return {
        value: metricThresholds[parts[1]],
        source: `config_category:${parts[1]}`,
      };
    }

    if (metricThresholds[assertion] !== undefined) {
      return {
        value: metricThresholds[assertion],
        source: `config_metric:${assertion}`,
      };
    }

    return {
      value: 'n/a',
      source: 'unknown',
    };
  };

  for (const row of data) {
    if (row.passed) continue;
    const route = routePath(row.url);
    const metric = String(row.assertion || 'lighthouse_assertion');
    const threshold = thresholdForAssertion(row);
    const findingId = `lh_${route.replace(/[^a-zA-Z0-9]+/g, '_')}_${metric.replace(/[^a-zA-Z0-9]+/g, '_')}`.toLowerCase();
    const actual = typeof row.numericValue === 'number' ? row.numericValue : String(row.value ?? 'n/a');
    findings.push({
      id: findingId,
      gate: 'lighthouse',
      severity: 'high',
      summary: row.message || `Lighthouse assertion failed: ${metric}`,
      route,
      metric,
      actual,
      threshold: threshold.value,
      status: 'fail',
      raw: {
        level: row.level,
        auditProperty: row.auditProperty,
        threshold_source: threshold.source,
        operator: row.operator ?? null,
      },
    });
  }

  return findings;
}

function findingForExitCode(gate, result) {
  return {
    id: `${gate}_exit_${Date.now()}`,
    gate,
    severity: gate === 'build' ? 'critical' : 'high',
    summary: `${gate} command failed with exit code ${result.exit_code}`,
    actual: result.exit_code,
    threshold: 0,
    status: 'fail',
    raw: {
      command: result.command,
      stderr_excerpt: result.stderr.split('\n').slice(0, 30).join('\n'),
      stdout_excerpt: result.stdout.split('\n').slice(0, 30).join('\n'),
    },
  };
}

export function runDeterministicGates({ mode, cwd, config, changedFiles }) {
  const scripts = packageScripts(cwd);
  const traces = [];
  const findings = [];

  const gatePlan = [
    { name: 'lint', enabled: true },
    { name: 'typecheck', enabled: true },
    { name: 'build', enabled: mode === 'full' },
    { name: 'lighthouse', enabled: true },
  ];

  const gates = [];

  for (const gate of gatePlan) {
    if (!gate.enabled) {
      gates.push({ name: gate.name, status: 'skipped', duration_ms: 0 });
      continue;
    }

    const command = resolveGateCommand(gate.name, scripts, config.commands);
    if (!command) {
      gates.push({ name: gate.name, status: 'fail', duration_ms: 0 });
      findings.push({
        id: `${gate.name}_missing_command`,
        gate: gate.name,
        severity: 'high',
        summary: `No command configured for gate: ${gate.name}`,
        files: changedFiles,
        actual: 'missing',
        threshold: 'configured_command_required',
        status: 'fail',
      });
      continue;
    }

    const result = runCommand(command, { cwd });
    traces.push(result);

    const status = result.exit_code === 0 ? 'pass' : 'fail';
    gates.push({ name: gate.name, status, duration_ms: result.duration_ms });

    if (status === 'fail') {
      if (gate.name === 'lighthouse') {
        const lighthouseFindings = parseLighthouseFindings(cwd, config.lighthouse.thresholds);
        if (lighthouseFindings.length > 0) {
          findings.push(...lighthouseFindings);
        } else {
          findings.push(findingForExitCode(gate.name, result));
        }
      } else {
        findings.push(findingForExitCode(gate.name, result));
      }
    }
  }

  return {
    gates,
    findings,
    traces,
  };
}
