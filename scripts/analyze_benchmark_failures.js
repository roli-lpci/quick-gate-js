import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.log('Usage: node scripts/analyze_benchmark_failures.js --input <benchmark.json>');
}

function parseArgs() {
  const args = {};
  const rest = process.argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith('--')) continue;
    const k = rest[i].slice(2);
    const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : 'true';
    args[k] = v;
    if (v !== 'true') i += 1;
  }
  return args;
}

function topCounts(items) {
  const m = new Map();
  for (const x of items) m.set(x, (m.get(x) || 0) + 1);
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
}

function buildHypotheses(data) {
  const failedPatchable = data.results.filter(
    (r) => ['type', 'both', 'lint'].includes(r.kind) && r.final_status !== 'pass',
  );

  const reasonCodes = topCounts(failedPatchable.map((r) => r.reason_code || 'none'));
  const actionReasons = topCounts(failedPatchable.flatMap((r) => r.action_reasons || []));

  const hypotheses = [];

  if (reasonCodes.some(([k]) => k === 'NO_IMPROVEMENT')) {
    hypotheses.push({
      id: 'H1',
      statement: 'Model receives insufficiently targeted typecheck context, causing repeated non-improving edits.',
      test: 'Add exact failing line spans + stricter file excerpt slicing; rerun full benchmark.',
      success_metric: 'Patchable pass rate +0.1 without safety regressions.',
    });
  }

  if (actionReasons.some(([k]) => k === 'invalid_edit_plan_json' || k === 'apply_plan_failed')) {
    hypotheses.push({
      id: 'H2',
      statement: 'Edit-plan JSON schema is too permissive for weaker models and needs a repair parser/retry.',
      test: 'Add one retry with JSON repair and stricter parser for plan fields.',
      success_metric: 'Reduce invalid-edit-plan failures by >=50%.',
    });
  }

  if (actionReasons.some(([k]) => k === 'model_command_timeout')) {
    hypotheses.push({
      id: 'H3',
      statement: 'Current model timeout policy is too tight for some local models.',
      test: 'Adaptive timeout by model class and skip hint calls when deterministic errors are explicit.',
      success_metric: 'Timeout-related failures reduced with <=15% runtime increase.',
    });
  }

  if (hypotheses.length === 0) {
    hypotheses.push({
      id: 'H0',
      statement: 'Failures appear distributed; need richer per-attempt telemetry.',
      test: 'Persist attempt-level traces and rerun benchmark for clearer clustering.',
      success_metric: 'Top 2 failure clusters explain >=70% of patchable failures.',
    });
  }

  return { reasonCodes, actionReasons, hypotheses };
}

function toMarkdown({ inputPath, data, analysis }) {
  const lines = [];
  lines.push('# Benchmark Failure Analysis');
  lines.push('');
  lines.push(`- Input: \`${inputPath}\``);
  lines.push(`- Lane: hint=\`${data.lane.hint_model}\`, patch=\`${data.lane.patch_model}\``);
  lines.push(`- Patchable pass rate: ${data.summary.metrics.patchable_pass_rate}`);
  lines.push(`- Gate passed: ${data.summary.benchmark_gate_passed ? 'YES' : 'NO'}`);
  lines.push('');
  lines.push('## Failure Patterns');
  lines.push('');
  lines.push('### Reason Codes (patchable failures)');
  for (const [k, v] of analysis.reasonCodes) lines.push(`- ${k}: ${v}`);
  lines.push('');
  lines.push('### Action Reasons (patch attempts)');
  if (analysis.actionReasons.length === 0) {
    lines.push('- none');
  } else {
    for (const [k, v] of analysis.actionReasons) lines.push(`- ${k}: ${v}`);
  }
  lines.push('');
  lines.push('## Hypotheses and Tests');
  lines.push('');
  for (const h of analysis.hypotheses) {
    lines.push(`- ${h.id}: ${h.statement}`);
    lines.push(`  Test: ${h.test}`);
    lines.push(`  Success metric: ${h.success_metric}`);
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs();
  if (!args.input) {
    usage();
    process.exit(1);
  }

  const inputPath = path.resolve(args.input);
  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const analysis = buildHypotheses(data);

  const outJson = inputPath.replace(/\.json$/, '.analysis.json');
  const outMd = inputPath.replace(/\.json$/, '.analysis.md');
  const payload = { input: inputPath, analysis };

  fs.writeFileSync(outJson, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(outMd, toMarkdown({ inputPath, data, analysis }), 'utf8');

  console.log(JSON.stringify({ outJson, outMd }, null, 2));
}

main();
