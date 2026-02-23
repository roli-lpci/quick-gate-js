#!/usr/bin/env node
import path from 'node:path';
import { loadChangedFiles } from './fs-utils.js';
import { executeRun } from './run-command.js';
import { executeSummarize } from './summarize-command.js';
import { executeRepair } from './repair-command.js';
import { checkEnvironment, hasOllama } from './env-check.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.replace(/^--/, '');
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
    args[key] = value;
    if (value !== true) i += 1;
  }
  return args;
}

function usage() {
  console.log(`Quick Gate v0.2.0-alpha

Commands:
  quick-gate run --mode canary|full --changed-files <path>
  quick-gate summarize --input .quick-gate/failures.json
  quick-gate repair --input .quick-gate/failures.json [--max-attempts 3] [--deterministic-only]

Options:
  --deterministic-only   Skip model-assisted repair (no Ollama required)
  --help, -h             Show this help message`);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }

  const args = parseArgs(rest);

  const warnings = checkEnvironment({ command: cmd });
  for (const w of warnings) {
    console.error(`[quick-gate] ${w}`);
  }

  try {
    if (cmd === 'run') {
      if (!args.mode || !['canary', 'full'].includes(String(args.mode))) {
        throw new Error('run requires --mode canary|full');
      }
      if (!args['changed-files']) {
        throw new Error('run requires --changed-files <path>');
      }
      const changedFilesPath = path.resolve(process.cwd(), String(args['changed-files']));
      const changedFiles = loadChangedFiles(changedFilesPath);
      const result = executeRun({ mode: String(args.mode), changedFiles });
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === 'pass' ? 0 : 1);
    }

    if (cmd === 'summarize') {
      if (!args.input) {
        throw new Error('summarize requires --input <path>');
      }
      const result = executeSummarize({ input: String(args.input) });
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }

    if (cmd === 'repair') {
      if (!args.input) {
        throw new Error('repair requires --input <path>');
      }
      const deterministicOnly = args['deterministic-only'] === true || !hasOllama();
      const result = executeRepair({
        input: String(args.input),
        maxAttempts: args['max-attempts'],
        deterministicOnly,
      });
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === 'pass' ? 0 : 2);
    }

    throw new Error(`Unknown command: ${cmd}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
