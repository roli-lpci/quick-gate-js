import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './exec.js';

function stripAnsi(text) {
  return String(text || '')
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[@-_]/g, '');
}

function safeSlice(text, max) {
  return String(text || '').slice(0, max);
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    const candidate = raw.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
}

function readSnippet(filePath, maxLines = 80) {
  if (!fs.existsSync(filePath)) return '';
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  return lines.slice(0, maxLines).join('\n');
}

function gatherFailureContext({ cwd, failures }) {
  const preferredFiles = [];
  const seen = new Set();
  const pushFile = (file) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    preferredFiles.push(file);
  };

  for (const file of failures.changed_files || []) pushFile(file);
  for (const f of failures.findings || []) {
    for (const file of f.files || []) pushFile(file);
  }

  const fileContext = [];
  for (const rel of preferredFiles.slice(0, 3)) {
    const full = path.join(cwd, rel);
    const snippet = readSnippet(full, 40);
    if (!snippet) continue;
    fileContext.push({ file: rel, snippet });
  }

  const findings = (failures.findings || []).map((f) => ({
    id: f.id,
    gate: f.gate,
    summary: f.summary,
    files: f.files || [],
    metric: f.metric || null,
    route: f.route || null,
    raw_context: safeSlice(f.raw?.stderr_excerpt || f.raw?.stdout_excerpt || '', 600),
  }));

  return { findings, file_context: fileContext, allowed_files: preferredFiles.slice(0, 12) };
}

function callOllama({ model, prompt, cwd, timeoutMs, purpose }) {
  if (!model) {
    return { ok: false, reason: 'missing_model' };
  }
  const mockEnv =
    purpose === 'hint'
      ? process.env.QUICK_GATE_MOCK_OLLAMA_HINT
      : process.env.QUICK_GATE_MOCK_OLLAMA_PATCH;
  if (mockEnv) {
    return { ok: true, output: mockEnv };
  }
  const escapedPrompt = prompt.replace(/'/g, `'"'"'`);
  const command = `printf '%s' '${escapedPrompt}' | ollama run ${model}`;
  const result = runCommand(command, { cwd, timeoutMs });
  if (result.exit_code !== 0) {
    return {
      ok: false,
      reason: result.timed_out ? 'model_command_timeout' : 'model_command_failed',
      stderr: safeSlice(result.timed_out ? '' : stripAnsi(result.stderr), 600),
      stdout: safeSlice(result.stdout, 1000),
    };
  }
  return { ok: true, output: result.stdout || '' };
}

function scoreEditPlan({ edits, failures, maxPatchLines }) {
  const changedFiles = new Set((failures.changed_files || []).map(String));
  const findingFiles = new Set(
    (failures.findings || []).flatMap((f) => (Array.isArray(f.files) ? f.files : [])),
  );

  const touched = new Set();
  let predictedLines = 0;
  for (const edit of edits) {
    touched.add(edit.file);
    const removed = Math.max(0, Number(edit.end_line) - Number(edit.start_line) + 1);
    const added = String(edit.replacement || '').split(/\r?\n/).length;
    predictedLines += removed + added;
  }

  const touchedFiles = Array.from(touched);
  const overlap = touchedFiles.filter((f) => changedFiles.has(f) || findingFiles.has(f)).length;
  const overlapRatio = touchedFiles.length === 0 ? 0 : overlap / touchedFiles.length;
  const lineScore = predictedLines <= maxPatchLines ? 1 : 0;
  const score = Number((overlapRatio * 0.7 + lineScore * 0.3).toFixed(2));

  return {
    score,
    predictedLines,
    touchedFiles,
  };
}

function normalizeEditPlan(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (!Array.isArray(payload.edits)) return null;
  const edits = payload.edits
    .map((e) => ({
      file: String(e.file || ''),
      start_line: Number(e.start_line),
      end_line: Number(e.end_line),
      replacement: String(e.replacement ?? ''),
    }))
    .filter((e) => e.file && Number.isInteger(e.start_line) && Number.isInteger(e.end_line));
  if (edits.length === 0) return null;
  return {
    summary: String(payload.summary || ''),
    edits,
  };
}

function sanitizePlanPaths(cwd, plan) {
  const normalized = {
    ...plan,
    edits: plan.edits.map((edit) => ({ ...edit })),
  };
  for (const edit of normalized.edits) {
    const raw = String(edit.file);
    if (path.isAbsolute(raw)) {
      if (raw.startsWith(`${cwd}${path.sep}`)) {
        edit.file = path.relative(cwd, raw);
      } else {
        return null;
      }
    }
  }
  return normalized;
}

function applyEditPlan({ cwd, plan }) {
  const touched = new Set();
  for (const edit of plan.edits) {
    const filePath = path.join(cwd, edit.file);
    if (!fs.existsSync(filePath)) {
      return { ok: false, reason: `missing_file:${edit.file}` };
    }

    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const startIndex = edit.start_line - 1;
    const endIndexExclusive = edit.end_line;
    if (startIndex < 0 || endIndexExclusive > lines.length || startIndex >= endIndexExclusive) {
      return { ok: false, reason: `invalid_line_range:${edit.file}:${edit.start_line}-${edit.end_line}` };
    }

    const replacementLines = String(edit.replacement).split(/\r?\n/);
    const updated = [
      ...lines.slice(0, startIndex),
      ...replacementLines,
      ...lines.slice(endIndexExclusive),
    ].join('\n');

    fs.writeFileSync(filePath, updated, 'utf8');
    touched.add(edit.file);
  }

  return { ok: true, touched_files: Array.from(touched) };
}

function buildHintPrompt(context) {
  return [
    'You are assisting a deterministic repair loop.',
    'Return JSON only: {"hints":[{"finding_id":"...","hint":"...","confidence":"low|medium|high"}]}',
    'Keep hints short and actionable.',
    JSON.stringify(context),
  ].join('\n');
}

function buildPatchPrompt(context) {
  return [
    'You are generating an edit plan for deterministic code repair.',
    'Return JSON only with shape:',
    '{"summary":"...","edits":[{"file":"path","start_line":1,"end_line":1,"replacement":"new content"}]}',
    'Rules: touch minimal files, stay within error scope, no prose, no markdown.',
    'Use ONLY file paths from allowed_files.',
    JSON.stringify(context),
  ].join('\n');
}

export function getModelRoutingPolicy() {
  const hintModel = process.env.QUICK_GATE_HINT_MODEL || 'qwen2.5:1.5b';
  const patchModel = process.env.QUICK_GATE_PATCH_MODEL || 'mistral:7b';
  const allowHintOnlyPatch = process.env.QUICK_GATE_ALLOW_HINT_ONLY_PATCH === '1';
  const hintOnly = allowHintOnlyPatch
    ? new Set()
    : new Set(['qwen2.5:1.5b', 'qwen3:4b', 'llama3.2:latest']);
  return {
    hintModel,
    patchModel,
    hintOnly,
    allowHintOnlyPatch,
    timeoutMs: Number(process.env.QUICK_GATE_MODEL_TIMEOUT_MS || 60000),
  };
}

export function runHintModel({ cwd, failures, policy }) {
  const context = gatherFailureContext({ cwd, failures });
  const prompt = buildHintPrompt(context);
  const response = callOllama({
    model: policy.hintModel,
    prompt,
    cwd,
    timeoutMs: policy.timeoutMs,
    purpose: 'hint',
  });

  if (!response.ok) {
    return {
      attempted: true,
      strategy: 'ollama_hint',
      accepted: false,
      model: policy.hintModel,
      reason: response.reason,
      stderr: response.stderr,
    };
  }

  const parsed = parseJsonObject(response.output);
  const hints = Array.isArray(parsed?.hints) ? parsed.hints.slice(0, 6) : [];
  return {
    attempted: true,
    strategy: 'ollama_hint',
    accepted: true,
    model: policy.hintModel,
    hints,
  };
}

export function runPatchModel({ cwd, failures, policy, maxPatchLines }) {
  if (policy.hintOnly.has(policy.patchModel)) {
    return {
      attempted: false,
      strategy: 'ollama_patch_plan',
      accepted: false,
      model: policy.patchModel,
      reason: 'patch_model_is_hint_only',
    };
  }

  const context = gatherFailureContext({ cwd, failures });
  const prompt = buildPatchPrompt(context);
  let response = callOllama({
    model: policy.patchModel,
    prompt,
    cwd,
    timeoutMs: policy.timeoutMs,
    purpose: 'patch',
  });

  if (!response.ok) {
    return {
      attempted: true,
      strategy: 'ollama_patch_plan',
      accepted: false,
      model: policy.patchModel,
      reason: response.reason,
      stderr: response.stderr,
    };
  }

  let parsed = parseJsonObject(response.output);
  let basePlan = normalizeEditPlan(parsed);
  let plan = basePlan ? sanitizePlanPaths(cwd, basePlan) : null;

  if (!plan) {
    const retryPrompt = [
      'Return valid minified JSON only.',
      'No prose, no markdown fences.',
      'Schema: {"summary":"...","edits":[{"file":"path","start_line":1,"end_line":1,"replacement":"text"}]}',
      `Allowed files: ${JSON.stringify(context.allowed_files || [])}`,
      'Previous invalid output:',
      safeSlice(response.output, 1200),
    ].join('\n');
    response = callOllama({
      model: policy.patchModel,
      prompt: retryPrompt,
      cwd,
      timeoutMs: policy.timeoutMs,
      purpose: 'patch',
    });
    if (response.ok) {
      parsed = parseJsonObject(response.output);
      basePlan = normalizeEditPlan(parsed);
      plan = basePlan ? sanitizePlanPaths(cwd, basePlan) : null;
    }
  }

  if (!plan) {
    return {
      attempted: true,
      strategy: 'ollama_patch_plan',
      accepted: false,
      model: policy.patchModel,
      reason: 'invalid_edit_plan_json',
      output_excerpt: safeSlice(response.output, 500),
    };
  }

  const allowed = new Set(context.allowed_files || []);
  const outOfScope = plan.edits
    .map((e) => e.file)
    .filter((file) => !allowed.has(file));
  if (outOfScope.length > 0) {
    return {
      attempted: true,
      strategy: 'ollama_patch_plan',
      accepted: false,
      model: policy.patchModel,
      reason: 'file_out_of_scope',
      out_of_scope_files: outOfScope,
      proposal: plan,
    };
  }

  const scoring = scoreEditPlan({ edits: plan.edits, failures, maxPatchLines });
  if (scoring.predictedLines > maxPatchLines) {
    return {
      attempted: true,
      strategy: 'ollama_patch_plan',
      accepted: false,
      model: policy.patchModel,
      reason: 'patch_budget_exceeded',
      predicted_lines: scoring.predictedLines,
      max_patch_lines: maxPatchLines,
    };
  }

  if (scoring.score < 0.5) {
    return {
      attempted: true,
      strategy: 'ollama_patch_plan',
      accepted: false,
      model: policy.patchModel,
      reason: 'diff_score_too_low',
      score: scoring.score,
      touched_files: scoring.touchedFiles,
      proposal: plan,
    };
  }

  const applied = applyEditPlan({ cwd, plan });
  if (!applied.ok) {
    return {
      attempted: true,
      strategy: 'ollama_patch_plan',
      accepted: false,
      model: policy.patchModel,
      reason: 'apply_plan_failed',
      details: applied.reason,
      proposal: plan,
    };
  }

  return {
    attempted: true,
    strategy: 'ollama_patch_plan',
    accepted: true,
    model: policy.patchModel,
    score: scoring.score,
    patch_lines: scoring.predictedLines,
    touched_files: scoring.touchedFiles,
    summary: plan.summary,
    proposal: plan,
  };
}
