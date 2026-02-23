import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateAgainstSchema } from '../src/schema.js';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fixtureDir = path.join(repoRoot, 'demo', 'benchmark-fixture');
const cliPath = path.join(repoRoot, 'src', 'cli.js');
const outDir = path.join(repoRoot, 'demo', 'model-tests');
const externalBuildBlock = path.join(os.tmpdir(), 'quickgate_benchmark_build.block');
const externalLhBlock = path.join(os.tmpdir(), 'quickgate_benchmark_lighthouse.block');

function run(cmd, cwd, env = {}, timeout = 300000) {
  const r = spawnSync(cmd, {
    shell: true,
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout,
    maxBuffer: 50 * 1024 * 1024,
  });
  return {
    code: typeof r.status === 'number' ? r.status : 1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

// ---------------------------------------------------------------------------
// Fixture setup: multi-file Next.js-like project
// ---------------------------------------------------------------------------

function ensureFixture() {
  for (const sub of ['src', 'src/components', 'src/hooks', 'src/lib', 'scripts']) {
    fs.mkdirSync(path.join(fixtureDir, sub), { recursive: true });
  }

  const pkg = {
    name: 'quick-gate-benchmark-fixture',
    private: true,
    type: 'module',
    scripts: {
      lint: 'node scripts/check.js lint',
      typecheck: 'node scripts/check.js typecheck',
      build: 'node scripts/check.js build',
      lighthouse: 'node scripts/check.js lighthouse',
    },
  };
  fs.writeFileSync(path.join(fixtureDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  // Sophisticated check script that validates multiple files and produces realistic errors
  const checkScript = buildCheckScript();
  fs.writeFileSync(path.join(fixtureDir, 'scripts', 'check.js'), checkScript, 'utf8');

  // Write baseline (clean) files
  writeBaselineFiles();

  fs.writeFileSync(path.join(fixtureDir, 'changed-files.txt'), 'src/app.ts\nsrc/lib/utils.ts\nsrc/components/Card.tsx\nsrc/hooks/useData.ts\n', 'utf8');

  if (!fs.existsSync(path.join(fixtureDir, '.git'))) {
    run('git init', fixtureDir);
    run('git add .', fixtureDir);
    run("git commit -m 'benchmark baseline'", fixtureDir);
  } else {
    run('git add .', fixtureDir);
    run("git commit -m 'benchmark fixture update' || true", fixtureDir);
  }
}

function writeBaselineFiles() {
  // Types file -- shared type definitions (always clean)
  fs.writeFileSync(path.join(fixtureDir, 'src', 'types.ts'), [
    "export interface User { id: string; name: string; email: string; }",
    "export interface ApiResponse<T> { data: T; error: string | null; status: number; }",
    "export type Theme = 'light' | 'dark';",
    "export interface CardProps { title: string; description: string; onClick?: () => void; }",
    "",
  ].join('\n'), 'utf8');

  // Clean versions of all mutable files
  fs.writeFileSync(path.join(fixtureDir, 'src', 'app.ts'), [
    "import { User } from './types';",
    "export function getUser(id: string): User {",
    "  return { id, name: 'test', email: 'test@example.com' };",
    "}",
    "",
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(fixtureDir, 'src', 'lib', 'utils.ts'), [
    "export function formatDate(date: Date): string {",
    "  return date.toISOString().split('T')[0];",
    "}",
    "export function clamp(value: number, min: number, max: number): number {",
    "  return Math.min(Math.max(value, min), max);",
    "}",
    "",
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(fixtureDir, 'src', 'components', 'Card.tsx'), [
    "import { CardProps } from '../types';",
    "export function Card({ title, description, onClick }: CardProps) {",
    "  return null; // JSX placeholder",
    "}",
    "",
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(fixtureDir, 'src', 'hooks', 'useData.ts'), [
    "import { ApiResponse } from '../types';",
    "export function useData<T>(url: string): ApiResponse<T> {",
    "  return { data: null as unknown as T, error: null, status: 200 };",
    "}",
    "",
  ].join('\n'), 'utf8');
}

// ---------------------------------------------------------------------------
// Check script: realistic ESLint + TypeScript error simulation
// ---------------------------------------------------------------------------

function buildCheckScript() {
  return `import fs from 'node:fs';
import path from 'node:path';

const gate = process.argv[2];

function readFile(rel) {
  try { return fs.readFileSync(rel, 'utf8'); } catch { return ''; }
}

function lintCheck() {
  const errors = [];
  const files = ['src/app.ts', 'src/lib/utils.ts', 'src/components/Card.tsx', 'src/hooks/useData.ts'];

  for (const file of files) {
    const c = readFile(file);
    if (!c) continue;

    // Unused imports: import { X } from '...' where X is not used elsewhere
    const importMatch = c.match(/import\\s+\\{([^}]+)\\}\\s+from/g);
    if (importMatch) {
      for (const imp of importMatch) {
        const names = imp.match(/\\{([^}]+)\\}/)?.[1]?.split(',').map(s => s.trim()) || [];
        for (const name of names) {
          if (!name) continue;
          const uses = c.split(name).length - 1;
          // Only in import = 1 occurrence = unused
          if (uses === 1 && !c.includes('export { ' + name)) {
            // Check it's truly only in the import line
            const lines = c.split('\\n');
            const importLine = lines.findIndex(l => l.includes('import') && l.includes(name));
            const otherUses = lines.filter((l, i) => i !== importLine && l.includes(name));
            if (otherUses.length === 0) {
              errors.push({ file, line: importLine + 1, rule: 'no-unused-vars', msg: "'" + name + "' is defined but never used" });
            }
          }
        }
      }
    }

    // Unused variables: const/let x = ... where x is not used later
    const varMatches = [...c.matchAll(/(?:const|let)\\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\\s*[=:]/g)];
    for (const m of varMatches) {
      const varName = m[1];
      if (varName.startsWith('_')) continue; // conventional unused prefix
      const lines = c.split('\\n');
      const declLine = c.slice(0, m.index).split('\\n').length;
      const afterDecl = lines.slice(declLine).join('\\n');
      if (!afterDecl.includes(varName)) {
        errors.push({ file, line: declLine, rule: 'no-unused-vars', msg: "'" + varName + "' is defined but never used" });
      }
    }

    // console.log statements (no-console rule)
    const consoleMatches = [...c.matchAll(/console\\.(log|warn|info)\\(/g)];
    for (const m of consoleMatches) {
      const line = c.slice(0, m.index).split('\\n').length;
      errors.push({ file, line, rule: 'no-console', msg: 'Unexpected console statement' });
    }

    // Explicit any (no-explicit-any)
    const anyMatches = [...c.matchAll(/:\\s*any(?:\\s|[;,)\\]}])/g)];
    for (const m of anyMatches) {
      const line = c.slice(0, m.index).split('\\n').length;
      errors.push({ file, line, rule: '@typescript-eslint/no-explicit-any', msg: 'Unexpected any. Specify a different type' });
    }

    // Duplicate imports from same module
    const importPaths = [...c.matchAll(/from\\s+['\"]([^'\"]+)['\"]/g)].map(m => m[1]);
    const seen = new Set();
    for (const p of importPaths) {
      if (seen.has(p)) {
        errors.push({ file, line: 1, rule: 'no-duplicate-imports', msg: "'" + p + "' imported multiple times" });
      }
      seen.add(p);
    }

    // React: missing key in .map() call
    if (c.includes('.map(') && c.includes('return') && !c.includes('key=') && !c.includes('key:')) {
      const mapLine = c.split('\\n').findIndex(l => l.includes('.map('));
      if (mapLine >= 0) {
        errors.push({ file, line: mapLine + 1, rule: 'react/jsx-key', msg: 'Missing "key" prop for element in iterator' });
      }
    }
  }

  if (errors.length > 0) {
    // Output in ESLint-style format
    const byFile = {};
    for (const e of errors) {
      if (!byFile[e.file]) byFile[e.file] = [];
      byFile[e.file].push(e);
    }
    for (const [file, errs] of Object.entries(byFile)) {
      console.error(file);
      for (const e of errs) {
        console.error('  ' + e.line + ':1  error  ' + e.msg + '  ' + e.rule);
      }
      console.error('');
    }
    console.error('\\u2716 ' + errors.length + ' problem(s)');
    process.exit(1);
  }
  process.exit(0);
}

function typecheckCheck() {
  const errors = [];
  const files = ['src/app.ts', 'src/lib/utils.ts', 'src/components/Card.tsx', 'src/hooks/useData.ts'];
  const typesContent = readFile('src/types.ts');

  // Parse exported interfaces from types.ts
  const interfaces = {};
  const ifaceMatches = [...typesContent.matchAll(/export\\s+interface\\s+(\\w+)\\s*\\{([^}]*)\\}/g)];
  for (const m of ifaceMatches) {
    const name = m[1];
    const fields = {};
    const fieldMatches = [...m[2].matchAll(/(\\w+)(\\??)?:\\s*([^;]+)/g)];
    for (const fm of fieldMatches) {
      fields[fm[1]] = { type: fm[3].trim(), optional: !!fm[2] };
    }
    interfaces[name] = fields;
  }

  for (const file of files) {
    const c = readFile(file);
    if (!c) continue;
    const lines = c.split('\\n');

    // Type 'X' is not assignable to type 'Y'
    const assignMatches = [...c.matchAll(/(?:const|let)\\s+\\w+\\s*:\\s*(\\w+)\\s*=\\s*([^;]+)/g)];
    for (const m of assignMatches) {
      const declaredType = m[1];
      const value = m[2].trim();
      const line = c.slice(0, m.index).split('\\n').length;

      if (declaredType === 'string' && /^\\d+$/.test(value)) {
        errors.push({ file, line, code: 'TS2322', msg: "Type 'number' is not assignable to type 'string'" });
      }
      if (declaredType === 'number' && /^['\\"]/.test(value)) {
        errors.push({ file, line, code: 'TS2322', msg: "Type 'string' is not assignable to type 'number'" });
      }
      if (declaredType === 'boolean' && /^['\\"]/.test(value)) {
        errors.push({ file, line, code: 'TS2322', msg: "Type 'string' is not assignable to type 'boolean'" });
      }
    }

    // Missing properties in object literal matching interface
    for (const [ifName, fields] of Object.entries(interfaces)) {
      // Find return statements or variable assignments that use this interface
      const usageMatches = [...c.matchAll(new RegExp(':\\\\s*' + ifName + '\\\\s*[=]\\\\s*\\\\{', 'g'))];
      for (const um of usageMatches) {
        const startIdx = um.index + um[0].length - 1;
        let depth = 1;
        let endIdx = startIdx + 1;
        while (depth > 0 && endIdx < c.length) {
          if (c[endIdx] === '{') depth++;
          if (c[endIdx] === '}') depth--;
          endIdx++;
        }
        const objLiteral = c.slice(startIdx, endIdx);
        for (const [fieldName, fieldDef] of Object.entries(fields)) {
          if (!fieldDef.optional && !objLiteral.includes(fieldName)) {
            const line = c.slice(0, um.index).split('\\n').length;
            errors.push({ file, line, code: 'TS2741', msg: "Property '" + fieldName + "' is missing in type but required in type '" + ifName + "'" });
          }
        }
      }
    }

    // Function return type mismatch
    const fnMatches = [...c.matchAll(/function\\s+\\w+[^)]*\\)\\s*:\\s*(\\w+(?:<[^>]+>)?)\\s*\\{/g)];
    for (const fm of fnMatches) {
      const retType = fm[1];
      const fnStart = fm.index + fm[0].length;
      let depth = 1;
      let fnEnd = fnStart;
      while (depth > 0 && fnEnd < c.length) {
        if (c[fnEnd] === '{') depth++;
        if (c[fnEnd] === '}') depth--;
        fnEnd++;
      }
      const fnBody = c.slice(fnStart, fnEnd);

      // Check for 'return undefined' or missing return when non-void
      if (retType !== 'void' && !retType.startsWith('Promise') && !fnBody.includes('return')) {
        const line = c.slice(0, fm.index).split('\\n').length;
        errors.push({ file, line, code: 'TS2355', msg: "A function whose declared type is neither 'void' nor 'any' must return a value" });
      }
    }

    // Cannot find name (misspelled reference)
    const refMatches = [...c.matchAll(/(?:^|[^.'\\"])\\b([A-Z][a-zA-Z]+)(?=\\s*[({<.])/gm)];
    for (const rm of refMatches) {
      const name = rm[1];
      // Skip if it's imported or defined in this file or is a known global
      const knownGlobals = new Set(['Date', 'Math', 'JSON', 'Promise', 'Array', 'Object', 'Set', 'Map', 'Error', 'RegExp', 'Number', 'String', 'Boolean', 'Symbol', 'Function', 'Console']);
      if (knownGlobals.has(name)) continue;
      if (c.includes("import") && c.includes(name) && c.indexOf(name) < c.indexOf(name, c.indexOf(name) + 1)) continue;

      // Check if imported
      const importLine = lines.find(l => l.includes('import') && l.includes(name));
      if (importLine) continue;

      // Check if defined locally
      const defLine = lines.find(l => (l.includes('function ' + name) || l.includes('class ' + name) || l.includes('const ' + name) || l.includes('interface ' + name) || l.includes('type ' + name)));
      if (defLine) continue;

      // If it looks like an imported type that's NOT imported, flag it
      if (interfaces[name] || typesContent.includes('export type ' + name)) {
        const line = c.slice(0, rm.index).split('\\n').length;
        errors.push({ file, line, code: 'TS2304', msg: "Cannot find name '" + name + "'" });
      }
    }
  }

  if (errors.length > 0) {
    for (const e of errors) {
      console.error(e.file + '(' + e.line + ',1): error ' + e.code + ': ' + e.msg);
    }
    process.exit(1);
  }
  process.exit(0);
}

function buildCheck() {
  if (fs.existsSync('${externalBuildBlock}')) {
    console.error("error - Build failed");
    console.error("Module not found: Can't resolve './missing-module' in 'src/'");
    console.error("");
    console.error("Import trace for requested module:");
    console.error("  ./src/app.ts");
    console.error("  ./src/lib/utils.ts");
    process.exit(1);
  }
  process.exit(0);
}

function lighthouseCheck() {
  if (fs.existsSync('${externalLhBlock}')) {
    console.error("Error: Lighthouse assertion failed");
    console.error("");
    console.error("  categories:performance score of 0.42 is below threshold 0.8");
    console.error("  categories:accessibility score of 0.65 is below threshold 0.8");
    console.error("");
    console.error("2 assertion(s) failed for URL: http://localhost:3000/");
    process.exit(1);
  }
  process.exit(0);
}

if (gate === 'lint') lintCheck();
else if (gate === 'typecheck') typecheckCheck();
else if (gate === 'build') buildCheck();
else if (gate === 'lighthouse') lighthouseCheck();
else { console.error('Unknown gate: ' + gate); process.exit(1); }
`;
}

// ---------------------------------------------------------------------------
// Benchmark cases: 4 difficulty tiers
// ---------------------------------------------------------------------------

const CASES = [
  // ── TIER 1: Easy (any model should fix) ─────────────────────────────
  {
    id: 'easy_unused_import',
    tier: 'easy',
    kind: 'lint',
    description: 'Unused import in app.ts',
    patchable: true,
    files: {
      'src/app.ts': [
        "import { User, ApiResponse } from './types';",
        "export function getUser(id: string): User {",
        "  return { id, name: 'test', email: 'test@example.com' };",
        "}",
        "",
      ].join('\n'),
    },
  },
  {
    id: 'easy_console_log',
    tier: 'easy',
    kind: 'lint',
    description: 'Console.log left in production code',
    patchable: true,
    files: {
      'src/lib/utils.ts': [
        "export function formatDate(date: Date): string {",
        "  console.log('formatting date:', date);",
        "  return date.toISOString().split('T')[0];",
        "}",
        "export function clamp(value: number, min: number, max: number): number {",
        "  return Math.min(Math.max(value, min), max);",
        "}",
        "",
      ].join('\n'),
    },
  },
  {
    id: 'easy_type_mismatch',
    tier: 'easy',
    kind: 'type',
    description: 'Number assigned to string type',
    patchable: true,
    files: {
      'src/app.ts': [
        "import { User } from './types';",
        "const label: string = 42;",
        "export function getUser(id: string): User {",
        "  return { id, name: 'test', email: 'test@example.com' };",
        "}",
        "",
      ].join('\n'),
    },
  },

  // ── TIER 2: Medium (needs context from multiple files) ──────────────
  {
    id: 'medium_missing_interface_field',
    tier: 'medium',
    kind: 'type',
    description: 'Object literal missing required field from interface in types.ts',
    patchable: true,
    files: {
      'src/app.ts': [
        "import { User } from './types';",
        "export function getUser(id: string): User {",
        "  const user: User = { id, name: 'test' };",
        "  return user;",
        "}",
        "",
      ].join('\n'),
    },
  },
  {
    id: 'medium_explicit_any',
    tier: 'medium',
    kind: 'lint',
    description: 'Explicit any type where interface exists',
    patchable: true,
    files: {
      'src/hooks/useData.ts': [
        "export function useData(url: string): any {",
        "  return { data: null, error: null, status: 200 };",
        "}",
        "",
      ].join('\n'),
    },
  },
  {
    id: 'medium_unused_var_plus_console',
    tier: 'medium',
    kind: 'lint',
    description: 'Multiple lint errors: unused variable + console.log in different files',
    patchable: true,
    files: {
      'src/app.ts': [
        "import { User } from './types';",
        "const debugMode = true;",
        "export function getUser(id: string): User {",
        "  return { id, name: 'test', email: 'test@example.com' };",
        "}",
        "",
      ].join('\n'),
      'src/lib/utils.ts': [
        "export function formatDate(date: Date): string {",
        "  console.log('formatting');",
        "  return date.toISOString().split('T')[0];",
        "}",
        "export function clamp(value: number, min: number, max: number): number {",
        "  return Math.min(Math.max(value, min), max);",
        "}",
        "",
      ].join('\n'),
    },
  },
  {
    id: 'medium_cross_file_type_error',
    tier: 'medium',
    kind: 'both',
    description: 'Wrong return type in utils.ts causes type mismatch when consumed in app.ts',
    patchable: true,
    files: {
      'src/app.ts': [
        "import { User } from './types';",
        "import { formatDate } from './lib/utils';",
        "const today: number = formatDate(new Date());",
        "export function getUser(id: string): User {",
        "  return { id, name: 'test', email: 'test@example.com' };",
        "}",
        "",
      ].join('\n'),
    },
  },

  // ── TIER 3: Hard (needs architectural understanding) ────────────────
  {
    id: 'hard_multi_file_cascade',
    tier: 'hard',
    kind: 'both',
    description: 'Type error + lint error cascading across 3 files',
    patchable: true,
    files: {
      'src/app.ts': [
        "import { User } from './types';",
        "import { formatDate } from './lib/utils';",
        "const unused_timestamp = 999;",
        "export function getUser(id: string): User {",
        "  const user: User = { id, name: 'test' };",
        "  return user;",
        "}",
        "",
      ].join('\n'),
      'src/lib/utils.ts': [
        "export function formatDate(date: Date): string {",
        "  console.log('debug:', date);",
        "  return date.toISOString().split('T')[0];",
        "}",
        "export function clamp(value: number, min: number, max: number): number {",
        "  return Math.min(Math.max(value, min), max);",
        "}",
        "",
      ].join('\n'),
      'src/components/Card.tsx': [
        "import { CardProps } from '../types';",
        "const debugEnabled: boolean = 'true';",
        "export function Card({ title, description, onClick }: CardProps) {",
        "  return null;",
        "}",
        "",
      ].join('\n'),
    },
  },
  {
    id: 'hard_missing_return_plus_any',
    tier: 'hard',
    kind: 'both',
    description: 'Function missing return value + explicit any in hook',
    patchable: true,
    files: {
      'src/app.ts': [
        "import { User } from './types';",
        "export function getUser(id: string): User {",
        "  const user = { id, name: 'test', email: 'test@example.com' };",
        "}",
        "",
      ].join('\n'),
      'src/hooks/useData.ts': [
        "export function useData(url: string): any {",
        "  console.info('fetching:', url);",
        "  return { data: null, error: null, status: 200 };",
        "}",
        "",
      ].join('\n'),
    },
  },
  {
    id: 'hard_duplicate_imports_type_cascade',
    tier: 'hard',
    kind: 'both',
    description: 'Duplicate imports + cross-file type mismatch + unused var',
    patchable: true,
    files: {
      'src/app.ts': [
        "import { User } from './types';",
        "import { ApiResponse } from './types';",
        "const debugFlag = false;",
        "export function getUser(id: string): User {",
        "  const count: string = 42;",
        "  return { id, name: 'test', email: 'test@example.com' };",
        "}",
        "",
      ].join('\n'),
    },
  },

  // ── TIER 4: Unpatchable (must escalate correctly) ───────────────────
  {
    id: 'unpatchable_build_missing_module',
    tier: 'unpatchable',
    kind: 'build',
    description: 'Build fails due to missing module resolution (infra problem)',
    patchable: false,
    files: {},
  },
  {
    id: 'unpatchable_lighthouse_perf',
    tier: 'unpatchable',
    kind: 'lighthouse',
    description: 'Lighthouse performance regression (needs infra/config changes)',
    patchable: false,
    files: {},
  },
  {
    id: 'unpatchable_build_plus_lint',
    tier: 'unpatchable',
    kind: 'build',
    description: 'Build failure combined with lint issue -- build blocks everything',
    patchable: false,
    files: {
      'src/app.ts': [
        "import { User } from './types';",
        "console.log('debug');",
        "export function getUser(id: string): User {",
        "  return { id, name: 'test', email: 'test@example.com' };",
        "}",
        "",
      ].join('\n'),
    },
  },
];

// ---------------------------------------------------------------------------
// Case setup
// ---------------------------------------------------------------------------

function writeCase(caseObj) {
  // Reset all files to baseline
  writeBaselineFiles();

  // Apply case-specific file modifications
  for (const [rel, content] of Object.entries(caseObj.files || {})) {
    const full = path.join(fixtureDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  // Clean external block files
  if (fs.existsSync(externalBuildBlock)) fs.unlinkSync(externalBuildBlock);
  if (fs.existsSync(externalLhBlock)) fs.unlinkSync(externalLhBlock);

  // Set external blocks for build/lighthouse cases
  if (caseObj.kind === 'build') fs.writeFileSync(externalBuildBlock, 'locked\n', 'utf8');
  if (caseObj.kind === 'lighthouse') fs.writeFileSync(externalLhBlock, 'locked\n', 'utf8');
}

function buildCases() {
  const perCase = Math.max(1, Number(process.env.QUICK_GATE_BENCH_CASES_PER_KIND || 1));
  const cases = [];
  for (const caseObj of CASES) {
    for (let i = 1; i <= perCase; i += 1) {
      cases.push({ ...caseObj, runId: `${caseObj.id}_run${i}` });
    }
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

function parseOutcome() {
  const repairReportPath = path.join(fixtureDir, '.quick-gate', 'repair-report.json');
  const escalationPath = path.join(fixtureDir, '.quick-gate', 'escalation.json');
  if (fs.existsSync(repairReportPath)) {
    return JSON.parse(fs.readFileSync(repairReportPath, 'utf8'));
  }
  if (fs.existsSync(escalationPath)) {
    return JSON.parse(fs.readFileSync(escalationPath, 'utf8'));
  }
  return { status: 'unknown' };
}

function extractOutcomeMeta(outcome) {
  const attemptsArray = Array.isArray(outcome.attempts)
    ? outcome.attempts
    : Array.isArray(outcome.evidence?.attempts)
      ? outcome.evidence.attempts
      : [];

  const actionReasons = [];
  for (const a of attemptsArray) {
    for (const action of a.actions || []) {
      if (action.reason) actionReasons.push(String(action.reason));
    }
  }
  return {
    attemptsCount: attemptsArray.length || null,
    actionReasons,
  };
}

// ---------------------------------------------------------------------------
// Summary + reporting
// ---------------------------------------------------------------------------

function summarize(results) {
  const patchable = results.filter((r) => r.patchable);
  const unpatchable = results.filter((r) => !r.patchable);

  const byTier = {};
  for (const r of results) {
    if (!byTier[r.tier]) byTier[r.tier] = { total: 0, pass: 0, correct_escalation: 0 };
    byTier[r.tier].total += 1;
    if (r.final_status === 'pass') byTier[r.tier].pass += 1;
    if (!r.patchable && r.final_status === 'escalated') byTier[r.tier].correct_escalation += 1;
  }

  const patchablePasses = patchable.filter((r) => r.final_status === 'pass').length;
  const unpatchableFalsePass = unpatchable.filter((r) => r.final_status === 'pass').length;
  const correctEscalations = unpatchable.filter((r) => r.final_status === 'escalated').length;
  const schemaFailures = results.filter((r) => !r.failures_schema_valid || !r.brief_schema_valid).length;
  const unsafeApply = results.filter((r) => r.unsafe_apply === true).length;

  const attemptCounts = results
    .map((r) => r.attempts)
    .filter((n) => typeof n === 'number' && Number.isFinite(n))
    .sort((a, b) => a - b);
  const medianAttempts = attemptCounts.length === 0
    ? null
    : attemptCounts[Math.floor(attemptCounts.length / 2)];

  const patchableRate = patchable.length === 0 ? 0 : patchablePasses / patchable.length;
  const escalationAccuracy = unpatchable.length === 0 ? 1 : correctEscalations / unpatchable.length;
  const schemaRate = results.length === 0 ? 0 : (results.length - schemaFailures) / results.length;

  const tierRates = {};
  for (const [tier, data] of Object.entries(byTier)) {
    tierRates[tier] = {
      total: data.total,
      pass_rate: data.total === 0 ? 0 : Number((data.pass / data.total).toFixed(3)),
      correct_escalation_rate: data.total === 0 ? 0 : Number((data.correct_escalation / data.total).toFixed(3)),
    };
  }

  const thresholds = {
    easy_pass_rate_min: 0.9,
    medium_pass_rate_min: 0.5,
    hard_pass_rate_min: 0.3,
    overall_patchable_pass_rate_min: 0.5,
    escalation_accuracy_min: 1.0,
    unsafe_apply_rate_must_be: 0,
    schema_valid_rate_must_be: 1,
    unpatchable_false_pass_rate_must_be: 0,
  };

  const easyRate = tierRates.easy?.pass_rate ?? 0;
  const mediumRate = tierRates.medium?.pass_rate ?? 0;
  const hardRate = tierRates.hard?.pass_rate ?? 0;

  const pass = (
    patchableRate >= thresholds.overall_patchable_pass_rate_min &&
    easyRate >= thresholds.easy_pass_rate_min &&
    unsafeApply === thresholds.unsafe_apply_rate_must_be &&
    schemaRate === thresholds.schema_valid_rate_must_be &&
    unpatchableFalsePass === thresholds.unpatchable_false_pass_rate_must_be &&
    escalationAccuracy >= thresholds.escalation_accuracy_min
  );

  return {
    totals: {
      cases: results.length,
      patchable_cases: patchable.length,
      unpatchable_cases: unpatchable.length,
    },
    tier_breakdown: tierRates,
    metrics: {
      overall_patchable_pass_rate: Number(patchableRate.toFixed(3)),
      patchable_passes: patchablePasses,
      escalation_accuracy: Number(escalationAccuracy.toFixed(3)),
      correct_escalations: correctEscalations,
      unpatchable_false_passes: unpatchableFalsePass,
      schema_valid_rate: Number(schemaRate.toFixed(3)),
      schema_failures: schemaFailures,
      unsafe_apply_count: unsafeApply,
      median_attempts_overall: medianAttempts,
    },
    thresholds,
    benchmark_gate_passed: pass,
  };
}

function markdownReport(summary, results, reportPath) {
  const lines = [];
  lines.push('# Local Benchmark Report');
  lines.push('');
  lines.push(`- Report: \`${reportPath}\``);
  lines.push(`- Cases: ${summary.totals.cases} (${summary.totals.patchable_cases} patchable, ${summary.totals.unpatchable_cases} unpatchable)`);
  lines.push(`- Overall patchable pass rate: ${summary.metrics.overall_patchable_pass_rate}`);
  lines.push(`- Escalation accuracy: ${summary.metrics.escalation_accuracy}`);
  lines.push(`- Schema valid rate: ${summary.metrics.schema_valid_rate}`);
  lines.push(`- Gate passed: ${summary.benchmark_gate_passed ? 'YES' : 'NO'}`);
  lines.push('');
  lines.push('## Tier Breakdown');
  lines.push('');
  lines.push('| Tier | Cases | Pass Rate | Escalation Accuracy |');
  lines.push('|------|-------|-----------|---------------------|');
  for (const [tier, data] of Object.entries(summary.tier_breakdown)) {
    lines.push(`| ${tier} | ${data.total} | ${data.pass_rate} | ${data.correct_escalation_rate} |`);
  }
  lines.push('');
  lines.push('## Case Outcomes');
  lines.push('');
  for (const r of results) {
    const icon = r.final_status === 'pass' ? 'PASS' : r.final_status === 'escalated' ? 'ESC' : 'FAIL';
    lines.push(`- [${icon}] ${r.id} (${r.tier}/${r.kind}): ${r.final_status}${r.reason_code ? ` [${r.reason_code}]` : ''}`);
    if (r.description) lines.push(`  > ${r.description}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  ensureFixture();
  const cases = buildCases();
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const results = [];

  console.log(`Running ${cases.length} benchmark cases...`);
  console.log('');

  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i];
    console.log(`[${i + 1}/${cases.length}] ${c.id} (${c.tier}/${c.kind}): ${c.description}`);

    writeCase(c);
    run('rm -rf .quick-gate', fixtureDir);

    const runResult = run(`node '${cliPath}' run --mode full --changed-files changed-files.txt`, fixtureDir);
    const deterministicOnly = process.env.QUICK_GATE_DETERMINISTIC_ONLY === '1';
    const repairFlags = deterministicOnly ? '--deterministic-only' : '';
    const repairResult = run(
      `node '${cliPath}' repair --input .quick-gate/failures.json --max-attempts 2 ${repairFlags}`,
      fixtureDir,
      {
        QUICK_GATE_HINT_MODEL: process.env.QUICK_GATE_HINT_MODEL || 'qwen2.5:1.5b',
        QUICK_GATE_PATCH_MODEL: process.env.QUICK_GATE_PATCH_MODEL || 'mistral:7b',
        QUICK_GATE_MODEL_TIMEOUT_MS: process.env.QUICK_GATE_MODEL_TIMEOUT_MS || '60000',
      },
      600000,
    );

    const failuresPath = path.join(fixtureDir, '.quick-gate', 'failures.json');
    const briefPath = path.join(fixtureDir, '.quick-gate', 'agent-brief.json');

    const failures = fs.existsSync(failuresPath) ? JSON.parse(fs.readFileSync(failuresPath, 'utf8')) : null;
    const brief = fs.existsSync(briefPath) ? JSON.parse(fs.readFileSync(briefPath, 'utf8')) : null;

    const vf = failures ? validateAgainstSchema('failures.schema.json', failures) : { valid: false };
    const vb = brief ? validateAgainstSchema('agent-brief.schema.json', brief) : { valid: false };

    const outcome = parseOutcome();
    const outcomeMeta = extractOutcomeMeta(outcome);

    const result = {
      id: c.runId,
      case_id: c.id,
      tier: c.tier,
      kind: c.kind,
      description: c.description,
      patchable: c.patchable,
      run_code: runResult.code,
      repair_code: repairResult.code,
      final_status: outcome.status || 'unknown',
      reason_code: outcome.reason_code || null,
      attempts: outcomeMeta.attemptsCount,
      action_reasons: outcomeMeta.actionReasons,
      failures_schema_valid: vf.valid,
      brief_schema_valid: vb.valid,
      unsafe_apply: false,
    };

    const icon = result.final_status === 'pass' ? 'PASS' : result.final_status === 'escalated' ? 'ESC ' : 'FAIL';
    console.log(`  -> [${icon}] ${result.final_status}${result.reason_code ? ` (${result.reason_code})` : ''}`);

    results.push(result);

    // Reset files for next case
    run('git checkout -- .', fixtureDir);
    if (fs.existsSync(externalBuildBlock)) fs.unlinkSync(externalBuildBlock);
    if (fs.existsSync(externalLhBlock)) fs.unlinkSync(externalLhBlock);
  }

  const summary = summarize(results);
  const report = {
    timestamp,
    lane: {
      hint_model: process.env.QUICK_GATE_HINT_MODEL || 'qwen2.5:1.5b',
      patch_model: process.env.QUICK_GATE_PATCH_MODEL || 'mistral:7b',
      timeout_ms: Number(process.env.QUICK_GATE_MODEL_TIMEOUT_MS || '60000'),
      deterministic_only: process.env.QUICK_GATE_DETERMINISTIC_ONLY === '1',
    },
    summary,
    results,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `benchmark-${timestamp}.json`);
  const mdPath = path.join(outDir, `benchmark-${timestamp}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, markdownReport(summary, results, jsonPath), 'utf8');

  console.log('');
  console.log(JSON.stringify({ jsonPath, mdPath, summary: report.summary }, null, 2));

  process.exit(report.summary.benchmark_gate_passed ? 0 : 3);
}

main();
