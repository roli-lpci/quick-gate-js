import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCommand as runShell } from './exec.js';
import { loadConfig } from './config.js';
import { nowIso, writeJsonFileSync, ensureDirSync } from './fs-utils.js';
import { runDeterministicGates } from './gates.js';
import {
  FAILURES_FILE,
  QUICK_GATE_DIR,
  RUN_METADATA_FILE,
} from './constants.js';
import { validateAgainstSchema } from './schema.js';
import { hasGit } from './env-check.js';

function gitInfo(cwd) {
  if (!hasGit()) return { repo: undefined, branch: undefined };
  const repoResult = runShell('git config --get remote.origin.url', { cwd });
  const branchResult = runShell('git rev-parse --abbrev-ref HEAD', { cwd });
  return {
    repo: repoResult.exit_code === 0 ? repoResult.stdout.trim() : undefined,
    branch: branchResult.exit_code === 0 ? branchResult.stdout.trim() : undefined,
  };
}

export function executeRun({ mode, changedFiles, cwd = process.cwd() }) {
  ensureDirSync(path.join(cwd, QUICK_GATE_DIR));

  const runId = `run_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const config = loadConfig(cwd);

  const gateResult = runDeterministicGates({ mode, cwd, config, changedFiles });
  const status = gateResult.findings.length > 0 ? 'fail' : 'pass';
  const git = gitInfo(cwd);

  const failuresPayload = {
    version: '1.0.0',
    run_id: runId,
    mode,
    status,
    timestamp: nowIso(),
    repo: git.repo,
    branch: git.branch,
    changed_files: changedFiles,
    gates: gateResult.gates,
    findings: gateResult.findings,
    inferred_hints: gateResult.findings.map((finding) => ({
      finding_id: finding.id,
      hint: `Start with the deterministic gate failure in ${finding.gate} and inspect command output in run-metadata traces.`,
      confidence: 'low',
    })),
  };

  const validation = validateAgainstSchema('failures.schema.json', failuresPayload);
  if (!validation.valid) {
    throw new Error(`failures.json schema validation failed: ${JSON.stringify(validation.errors, null, 2)}`);
  }

  const metadataPayload = {
    run_id: runId,
    mode,
    started_at: new Date(startedAt).toISOString(),
    completed_at: nowIso(),
    duration_ms: Date.now() - startedAt,
    config_source: config.source,
    command_traces: gateResult.traces,
  };

  writeJsonFileSync(path.join(cwd, FAILURES_FILE), failuresPayload);
  writeJsonFileSync(path.join(cwd, RUN_METADATA_FILE), metadataPayload);

  return {
    status,
    failuresPath: path.join(cwd, FAILURES_FILE),
    metadataPath: path.join(cwd, RUN_METADATA_FILE),
    runId,
  };
}
