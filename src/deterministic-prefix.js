import path from 'node:path';
import { runCommand } from './exec.js';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function inScopeFiles(failures) {
  const fromChanged = Array.isArray(failures.changed_files) ? failures.changed_files : [];
  const fromFindings = (failures.findings || []).flatMap((f) => (Array.isArray(f.files) ? f.files : []));
  const unique = [];
  const seen = new Set();
  for (const file of [...fromChanged, ...fromFindings]) {
    if (!file || seen.has(file)) continue;
    seen.add(file);
    unique.push(file);
  }
  return unique;
}

function hasGateFailure(failures, gate) {
  return (failures.findings || []).some((f) => f.gate === gate);
}

function runLintProblemAutofix({ cwd, files }) {
  if (files.length === 0) return null;
  const fileArgs = files.map((f) => shellQuote(f)).join(' ');
  const cmd = `npx eslint ${fileArgs} --fix --fix-type problem`;
  const result = runCommand(cmd, { cwd });
  return {
    rule_id: 'LINT_PROBLEM_AUTOFIX',
    strategy: 'deterministic_prefix',
    accepted: result.exit_code === 0,
    command: cmd,
    exit_code: result.exit_code,
    files,
    rationale: 'Apply only ESLint problem fixes on scoped files to minimize semantic-risk edits.',
  };
}

export function runDeterministicPreFix({ cwd, failures }) {
  const actions = [];
  const isEligibleFile = (f) => {
    if (!/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(f)) return false;
    if (/(^|\/)(dist|build|coverage|\.next)\//.test(f)) return false;
    if (/\.min\.(js|mjs|cjs)$/.test(f)) return false;
    return true;
  };
  const scopedFiles = inScopeFiles(failures)
    .filter((f) => !f.startsWith('.'))
    .filter((f) => !path.isAbsolute(f))
    .filter((f) => !f.includes('..'))
    .filter((f) => !f.includes('node_modules'))
    .filter((f) => path.extname(f) !== '')
    .filter((f) => isEligibleFile(f))
    .slice(0, 20);

  // Rule 1 (low risk): only lint "problem" fixes, scoped to impacted files.
  if (hasGateFailure(failures, 'lint')) {
    const action = runLintProblemAutofix({ cwd, files: scopedFiles });
    if (action) actions.push(action);
  }

  // Future rules should follow same invariants: explicit trigger, scoped files, rollback-safe rerun.
  return actions;
}
