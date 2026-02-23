export const QUICK_GATE_DIR = '.quick-gate';
export const FAILURES_FILE = '.quick-gate/failures.json';
export const RUN_METADATA_FILE = '.quick-gate/run-metadata.json';
export const AGENT_BRIEF_MD_FILE = '.quick-gate/agent-brief.md';
export const AGENT_BRIEF_JSON_FILE = '.quick-gate/agent-brief.json';

export const DEFAULT_POLICY = {
  maxAttempts: 3,
  maxPatchLines: 150,
  abortOnNoImprovement: 2,
  timeCapMs: 20 * 60 * 1000,
};

export const ESCALATION_CODES = {
  NO_IMPROVEMENT: 'NO_IMPROVEMENT',
  PATCH_BUDGET_EXCEEDED: 'PATCH_BUDGET_EXCEEDED',
  ARCHITECTURAL_CHANGE_REQUIRED: 'ARCHITECTURAL_CHANGE_REQUIRED',
  FLAKY_EVALUATOR: 'FLAKY_EVALUATOR',
  UNKNOWN_BLOCKER: 'UNKNOWN_BLOCKER',
};
