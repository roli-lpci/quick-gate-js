import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

function parseArgs() {
  const args = {};
  const rest = process.argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    if (!t.startsWith('--')) continue;
    const k = t.slice(2);
    const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : 'true';
    args[k] = v;
    if (v !== 'true') i += 1;
  }
  return args;
}

function run(cmd, cwd, env = {}, timeout = 600000) {
  const r = spawnSync(cmd, {
    shell: true,
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout,
    maxBuffer: 50 * 1024 * 1024,
  });
  return {
    code: typeof r.status === 'number' ? r.status : 1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function insertAfterFirstLine(filePath, linesToInsert) {
  const raw = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const out = [raw[0], ...linesToInsert, ...raw.slice(1)].join('\n');
  fs.writeFileSync(filePath, out, 'utf8');
}

function ensureGateProxy(workspace) {
  const scriptPath = path.join(workspace, 'scripts', 'qg-external-gate.js');
  ensureDir(path.dirname(scriptPath));
  fs.writeFileSync(
    scriptPath,
    `import fs from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst gate = process.argv[2];\nconst lock = process.argv[3];\nconst passthrough = process.argv.slice(4).join(' ');\nif (fs.existsSync(lock)) { console.error('EXTERNAL_BLOCKER:' + gate + ':' + lock); process.exit(1); }\nconst r = spawnSync(passthrough, { shell: true, stdio: 'inherit' });\nprocess.exit(typeof r.status === 'number' ? r.status : 1);\n`,
    'utf8',
  );

  const cfgPath = path.join(workspace, 'quick-gate.config.json');
  const buildLock = path.join(os.tmpdir(), 'quickgate_real_build.lock');
  const lhLock = path.join(os.tmpdir(), 'quickgate_real_lh.lock');
  fs.writeFileSync(
    cfgPath,
    `${JSON.stringify(
      {
        commands: {
          lint: 'npm run lint',
          typecheck: 'npm run typecheck',
          build: `node scripts/qg-external-gate.js build ${buildLock} \"npm run build\"`,
          lighthouse: `node scripts/qg-external-gate.js lighthouse ${lhLock} \"npm run ci:lighthouse\"`,
          lint_fix: 'npm run lint -- --fix',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return { buildLock, lhLock };
}

function scenarios(countPerCategory = 3) {
  const list = [];
  const base = [
    {
      category: 'patchable_lint',
      file: 'app/page.tsx',
      lines: ['const __qg_unused = 1;'],
      lock: null,
    },
    {
      category: 'patchable_type',
      file: 'app/method/page.tsx',
      lines: ['const __qg_type: string = 42;'],
      lock: null,
    },
    {
      category: 'patchable_both',
      file: 'components/ui/ButtonLink.tsx',
      lines: ['const __qg_unused = 1;', "const __qg_type: string = 42;"],
      lock: null,
    },
    {
      category: 'runtime_lighthouse',
      file: 'app/page.tsx',
      lines: ["if (typeof window === 'undefined') { throw new Error('QG_RUNTIME_FAIL'); }"],
      lock: null,
    },
    {
      category: 'unpatchable_lighthouse_external',
      file: 'app/contact/page.tsx',
      lines: ['// external lighthouse blocker scenario'],
      lock: 'lh',
    },
  ];

  for (let i = 1; i <= countPerCategory; i += 1) {
    for (const b of base) {
      list.push({ id: `${b.category}_${i}`, ...b });
    }
  }

  return list;
}

function extractActionReasons(report) {
  const attempts = Array.isArray(report?.attempts)
    ? report.attempts
    : Array.isArray(report?.evidence?.attempts)
      ? report.evidence.attempts
      : [];
  const reasons = [];
  for (const a of attempts) {
    for (const action of a.actions || []) {
      if (action.reason) reasons.push(String(action.reason));
    }
  }
  return reasons;
}

function runProfile({ workspace, quickGateRepo, outRoot, profile, scenarioCount }) {
  const profileDir = path.join(outRoot, profile.id);
  ensureDir(profileDir);
  ensureDir(path.join(profileDir, 'cases'));

  const locks = ensureGateProxy(workspace);
  const cases = scenarios(scenarioCount);
  const baselineByFile = new Map();
  const scenarioFiles = Array.from(new Set(cases.map((c) => c.file)));
  for (const rel of scenarioFiles) {
    const full = path.join(workspace, rel);
    baselineByFile.set(rel, fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null);
  }
  const records = [];
  const startedAt = Date.now();

  for (const s of cases) {
    for (const [rel, content] of baselineByFile.entries()) {
      const full = path.join(workspace, rel);
      if (content === null) {
        if (fs.existsSync(full)) fs.unlinkSync(full);
      } else {
        ensureDir(path.dirname(full));
        fs.writeFileSync(full, content, 'utf8');
      }
    }
    run('rm -rf .quick-gate', workspace);
    if (fs.existsSync(locks.buildLock)) fs.unlinkSync(locks.buildLock);
    if (fs.existsSync(locks.lhLock)) fs.unlinkSync(locks.lhLock);

    if (s.lock === 'lh') {
      fs.writeFileSync(locks.lhLock, 'locked\n', 'utf8');
    }

    const targetFile = path.join(workspace, s.file);
    if (!fs.existsSync(targetFile)) {
      records.push({ id: s.id, category: s.category, error: `missing_file:${s.file}` });
      continue;
    }

    insertAfterFirstLine(targetFile, s.lines);
    fs.writeFileSync(path.join(workspace, 'changed-files-experiment.txt'), `${s.file}\n`, 'utf8');

    const env = {
      QUICK_GATE_HINT_MODEL: profile.hintModel,
      QUICK_GATE_PATCH_MODEL: profile.patchModel,
      QUICK_GATE_ALLOW_HINT_ONLY_PATCH: profile.allowHintOnlyPatch ? '1' : '0',
      QUICK_GATE_MODEL_TIMEOUT_MS: String(profile.modelTimeoutMs),
    };

    const runRes = run(
      `node '${path.join(quickGateRepo, 'src', 'cli.js')}' run --mode canary --changed-files changed-files-experiment.txt`,
      workspace,
      env,
      900000,
    );

    const repairRes = run(
      `node '${path.join(quickGateRepo, 'src', 'cli.js')}' repair --input .quick-gate/failures.json --max-attempts 2`,
      workspace,
      env,
      900000,
    );

    const failures = readJsonSafe(path.join(workspace, '.quick-gate', 'failures.json'));
    const repairReport = readJsonSafe(path.join(workspace, '.quick-gate', 'repair-report.json'));
    const escalation = readJsonSafe(path.join(workspace, '.quick-gate', 'escalation.json'));

    const outcome = repairReport || escalation || { status: 'unknown' };
    const caseDir = path.join(profileDir, 'cases', s.id);
    ensureDir(caseDir);
    if (failures) fs.writeFileSync(path.join(caseDir, 'failures.json'), `${JSON.stringify(failures, null, 2)}\n`, 'utf8');
    if (repairReport) fs.writeFileSync(path.join(caseDir, 'repair-report.json'), `${JSON.stringify(repairReport, null, 2)}\n`, 'utf8');
    if (escalation) fs.writeFileSync(path.join(caseDir, 'escalation.json'), `${JSON.stringify(escalation, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(caseDir, 'run.stdout.txt'), runRes.stdout, 'utf8');
    fs.writeFileSync(path.join(caseDir, 'run.stderr.txt'), runRes.stderr, 'utf8');
    fs.writeFileSync(path.join(caseDir, 'repair.stdout.txt'), repairRes.stdout, 'utf8');
    fs.writeFileSync(path.join(caseDir, 'repair.stderr.txt'), repairRes.stderr, 'utf8');

    records.push({
      id: s.id,
      category: s.category,
      file: s.file,
      lock: s.lock,
      injected_lines: s.lines,
      run_code: runRes.code,
      repair_code: repairRes.code,
      finding_count_after_run: failures?.findings?.length ?? null,
      final_status: outcome.status || 'unknown',
      reason_code: outcome.reason_code || null,
      action_reasons: extractActionReasons(outcome),
    });
  }

  const patchableCategories = new Set(['patchable_lint', 'patchable_type', 'patchable_both', 'runtime_lighthouse']);
  const unpatchableCategories = new Set(['unpatchable_lighthouse_external']);

  const patchable = records.filter((r) => patchableCategories.has(r.category));
  const unpatchable = records.filter((r) => unpatchableCategories.has(r.category));

  const patchablePasses = patchable.filter((r) => r.final_status === 'pass').length;
  const unpatchableFalsePasses = unpatchable.filter((r) => r.final_status === 'pass').length;

  const summary = {
    profile: profile.id,
    lane: {
      hint_model: profile.hintModel,
      patch_model: profile.patchModel,
      allow_hint_only_patch: profile.allowHintOnlyPatch,
      model_timeout_ms: profile.modelTimeoutMs,
    },
    totals: {
      cases: records.length,
      patchable_cases: patchable.length,
      unpatchable_cases: unpatchable.length,
      duration_ms: Date.now() - startedAt,
    },
    metrics: {
      patchable_pass_rate: patchable.length ? Number((patchablePasses / patchable.length).toFixed(3)) : 0,
      patchable_passes: patchablePasses,
      unpatchable_false_passes: unpatchableFalsePasses,
    },
  };

  fs.writeFileSync(path.join(profileDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(profileDir, 'records.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

  return { summary, recordsPath: path.join(profileDir, 'records.jsonl') };
}

function markdownReport(expName, outRoot, profileResults) {
  const lines = [];
  lines.push(`# ${expName}`);
  lines.push('');
  lines.push(`Output root: \`${outRoot}\``);
  lines.push('');
  lines.push('## Profile Results');
  lines.push('');
  for (const p of profileResults) {
    lines.push(`- ${p.summary.profile}: patchable_pass_rate=${p.summary.metrics.patchable_pass_rate}, patchable_passes=${p.summary.metrics.patchable_passes}, unpatchable_false_passes=${p.summary.metrics.unpatchable_false_passes}, duration_ms=${p.summary.totals.duration_ms}`);
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs();
  const workspace = args.workspace;
  const quickGateRepo = args['quick-gate-repo'] || path.resolve(__dirname, '..');
  const scenarioCount = Number(args['cases-per-category'] || 3);

  if (!workspace) {
    console.error('Missing --workspace');
    process.exit(1);
  }

  const dateTag = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const expBase = args.name || `quick-gate-real-repo-eval-${dateTag}`;
  const expName = `${expBase}-${stamp}`;
  const outRoot = args['output-dir']
    ? path.join(args['output-dir'], expName)
    : path.join(quickGateRepo, 'demo', 'model-tests', expName);
  ensureDir(outRoot);

  const profiles = [
    {
      id: 'balanced_q25_m7b',
      hintModel: 'qwen2.5:1.5b',
      patchModel: 'mistral:7b',
      allowHintOnlyPatch: false,
      modelTimeoutMs: 30000,
    },
    {
      id: 'small_q25_q3',
      hintModel: 'qwen2.5:1.5b',
      patchModel: 'qwen3:4b',
      allowHintOnlyPatch: true,
      modelTimeoutMs: 20000,
    },
  ];
  const selected = String(args.profiles || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const profilesToRun = selected.length > 0
    ? profiles.filter((p) => selected.includes(p.id))
    : profiles;

  const profileResults = [];
  for (const profile of profilesToRun) {
    const count = profile.id === 'small_q25_q3' ? Math.max(1, scenarioCount - 1) : scenarioCount;
    profileResults.push(runProfile({
      workspace,
      quickGateRepo,
      outRoot,
      profile,
      scenarioCount: count,
    }));
  }

  const manifest = {
    experiment: expName,
    workspace,
    quick_gate_repo: quickGateRepo,
    generated_at: new Date().toISOString(),
    scenario_count_per_category: scenarioCount,
    profiles_requested: profilesToRun.map((p) => p.id),
    profiles: profileResults.map((p) => p.summary),
  };

  fs.writeFileSync(path.join(outRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outRoot, 'summary.md'), markdownReport(expName, outRoot, profileResults), 'utf8');

  console.log(JSON.stringify({ outRoot, manifest }, null, 2));
}

main();
