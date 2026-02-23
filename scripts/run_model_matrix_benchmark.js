import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const runner = path.join(repoRoot, 'scripts', 'run_local_benchmark.js');
const outDir = path.join(repoRoot, 'demo', 'model-tests');

const profiles = [
  {
    id: 'balanced_q25_m7b',
    hint: 'qwen2.5:1.5b',
    patch: 'mistral:7b',
    allowHintOnlyPatch: false,
  },
  {
    id: 'small_q25_q3',
    hint: 'qwen2.5:1.5b',
    patch: 'qwen3:4b',
    allowHintOnlyPatch: true,
  },
  {
    id: 'small_q3_q3',
    hint: 'qwen3:4b',
    patch: 'qwen3:4b',
    allowHintOnlyPatch: true,
  },
];

function selectedProfiles() {
  const requested = (process.env.QUICK_GATE_MATRIX_PROFILE_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (requested.length === 0) return profiles;
  const set = new Set(requested);
  return profiles.filter((p) => set.has(p.id));
}

function runProfile(profile) {
  const env = {
    ...process.env,
    QUICK_GATE_HINT_MODEL: profile.hint,
    QUICK_GATE_PATCH_MODEL: profile.patch,
    QUICK_GATE_ALLOW_HINT_ONLY_PATCH: profile.allowHintOnlyPatch ? '1' : '0',
    QUICK_GATE_MODEL_TIMEOUT_MS: process.env.QUICK_GATE_MODEL_TIMEOUT_MS || '45000',
    QUICK_GATE_BENCH_CASES_PER_KIND: process.env.QUICK_GATE_BENCH_CASES_PER_KIND || '3',
  };

  const started = Date.now();
  const r = spawnSync(`node '${runner}'`, {
    shell: true,
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    timeout: 90 * 60 * 1000,
    maxBuffer: 50 * 1024 * 1024,
  });

  const code = typeof r.status === 'number' ? r.status : 1;
  const stdout = r.stdout || '';
  let parsed = null;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    parsed = null;
  }

  let summary = null;
  if (parsed?.jsonPath && fs.existsSync(parsed.jsonPath)) {
    const report = JSON.parse(fs.readFileSync(parsed.jsonPath, 'utf8'));
    summary = report.summary;
  }

  return {
    profile,
    code,
    duration_ms: Date.now() - started,
    jsonPath: parsed?.jsonPath || null,
    mdPath: parsed?.mdPath || null,
    summary,
    stdout_excerpt: stdout.slice(0, 4000),
    stderr_excerpt: (r.stderr || '').slice(0, 2000),
  };
}

function main() {
  const profilesToRun = selectedProfiles();
  const results = profilesToRun.map(runProfile);
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const outJson = path.join(outDir, `matrix-${timestamp}.json`);
  const outMd = path.join(outDir, `matrix-${timestamp}.md`);

  const mdLines = [];
  mdLines.push('# Model Matrix Benchmark');
  mdLines.push('');
  mdLines.push(`- Cases per kind: ${process.env.QUICK_GATE_BENCH_CASES_PER_KIND || '3'}`);
  mdLines.push('');
  mdLines.push(`- Profiles run: ${profilesToRun.map((p) => p.id).join(', ')}`);
  mdLines.push('## Profiles');
  mdLines.push('');

  for (const r of results) {
    const s = r.summary?.metrics;
    mdLines.push(`- ${r.profile.id}: hint=${r.profile.hint}, patch=${r.profile.patch}, allow_hint_patch=${r.profile.allowHintOnlyPatch}`);
    if (s) {
      mdLines.push(`  patchable_pass_rate=${s.patchable_pass_rate}, unpatchable_false_passes=${s.unpatchable_false_passes}, gate_passed=${r.summary.benchmark_gate_passed}`);
    } else {
      mdLines.push(`  run_code=${r.code}, no summary parsed`);
    }
  }

  fs.writeFileSync(outJson, `${JSON.stringify({ timestamp, results }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(outMd, `${mdLines.join('\n')}\n`, 'utf8');

  console.log(JSON.stringify({ outJson, outMd }, null, 2));
}

main();
