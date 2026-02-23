import path from 'node:path';
import {
  AGENT_BRIEF_JSON_FILE,
  AGENT_BRIEF_MD_FILE,
  DEFAULT_POLICY,
} from './constants.js';
import { readJsonFileSync, writeJsonFileSync, writeTextFileSync } from './fs-utils.js';
import { validateAgainstSchema } from './schema.js';

function scopeForFinding(finding) {
  if (Array.isArray(finding.files) && finding.files.length === 1) return 'single_file';
  if (finding.route && (!finding.files || finding.files.length <= 1)) return 'single_route';
  return 'cross_route';
}

function actionForGate(gate) {
  if (gate === 'lint') return 'Apply targeted lint fixes and re-run lint deterministically.';
  if (gate === 'typecheck') return 'Resolve TypeScript errors for impacted files and re-run typecheck.';
  if (gate === 'build') return 'Fix build-breaking code paths and confirm production build passes.';
  return 'Reduce route-level performance/accessibility regressions and re-run lighthouse.';
}

function createMarkdown(failures, brief) {
  const lines = [];
  lines.push('# Quick Gate Agent Brief');
  lines.push('');
  lines.push(`Run: \`${failures.run_id}\``);
  lines.push(`Mode: \`${failures.mode}\``);
  lines.push(`Status: \`${failures.status}\``);
  lines.push('');
  lines.push('## Deterministic failures');
  lines.push('');

  if (failures.findings.length === 0) {
    lines.push('- No deterministic failures detected.');
  } else {
    for (const finding of failures.findings) {
      const routePart = finding.route ? ` (${finding.route})` : '';
      lines.push(`- \`${finding.id}\`${routePart}: ${finding.summary} (actual: ${finding.actual}, threshold: ${finding.threshold})`);
    }
  }

  lines.push('');
  lines.push('## Priority actions');
  lines.push('');
  if (brief.priority_actions.length === 0) {
    lines.push('- No actions required.');
  } else {
    for (const action of brief.priority_actions) {
      const targets = action.target_files?.length ? ` targets: ${action.target_files.join(', ')}` : '';
      lines.push(`- [${action.scope}] ${action.action}${targets}`);
    }
  }

  lines.push('');
  lines.push('## Retry policy');
  lines.push('');
  lines.push(`- Max attempts: ${brief.retry_policy.max_attempts}`);
  lines.push(`- Max patch lines: ${brief.retry_policy.max_patch_lines}`);
  lines.push(`- Abort on no improvement after: ${brief.retry_policy.abort_on_no_improvement} attempt(s)`);
  lines.push('');
  lines.push('## Escalation conditions');
  lines.push('');
  lines.push('- Escalate with reason code and evidence (`.quick-gate/failures.json`, `.quick-gate/run-metadata.json`) if unresolved.');
  lines.push('- Stop when no-improvement cap, patch budget, or time cap is hit.');

  return `${lines.join('\n')}\n`;
}

export function executeSummarize({ input, cwd = process.cwd() }) {
  const failures = readJsonFileSync(path.resolve(cwd, input));

  const priorityActions = failures.findings.map((finding) => ({
    finding_id: finding.id,
    action: actionForGate(finding.gate),
    scope: scopeForFinding(finding),
    target_files: finding.files || [],
    rationale: `${finding.gate} failed deterministically. Address this fact before any inferred optimizations.`,
  }));

  const brief = {
    run_id: failures.run_id,
    mode: failures.mode,
    status: failures.status,
    summary:
      failures.status === 'pass'
        ? 'All deterministic gates passed.'
        : `${failures.findings.length} deterministic finding(s) require repair.`,
    priority_actions: priorityActions,
    retry_policy: {
      max_attempts: DEFAULT_POLICY.maxAttempts,
      max_patch_lines: DEFAULT_POLICY.maxPatchLines,
      abort_on_no_improvement: DEFAULT_POLICY.abortOnNoImprovement,
    },
    escalation: failures.status === 'pass'
      ? { required: false }
      : {
        required: true,
        reason_code: 'UNRESOLVED_DETERMINISTIC_FAILURES',
        message: 'Escalate with evidence packet if bounded repair loop cannot clear deterministic failures.',
      },
  };

  const validation = validateAgainstSchema('agent-brief.schema.json', brief);
  if (!validation.valid) {
    throw new Error(`agent-brief schema validation failed: ${JSON.stringify(validation.errors, null, 2)}`);
  }

  const md = createMarkdown(failures, brief);
  writeJsonFileSync(path.join(cwd, AGENT_BRIEF_JSON_FILE), brief);
  writeTextFileSync(path.join(cwd, AGENT_BRIEF_MD_FILE), md);

  return {
    briefJsonPath: path.join(cwd, AGENT_BRIEF_JSON_FILE),
    briefMdPath: path.join(cwd, AGENT_BRIEF_MD_FILE),
    status: brief.status,
  };
}
