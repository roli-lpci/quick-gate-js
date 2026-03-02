# Quick Gate JS

Deterministic quality gate CLI for TypeScript/ESLint projects. Runs lint + typecheck + test gates, produces structured JSON artifacts, supports bounded auto-repair.

## Commands

- `npm install` -- Install
- `node --test test/*.test.js` -- 44 tests, all offline
- `node --test test/gates.test.js` -- Single file
- `npx quick-gate run` -- Run gates
- `npx quick-gate repair` -- Auto-fix loop
- `npx quick-gate summarize` -- Agent brief

## Architecture

Three subcommands: `run` (execute gates) → `repair` (auto-fix loop) → `summarize` (agent brief).

```
src/
  cli.js → run-command.js / repair-command.js / summarize-command.js
  gates.js          # Gate resolution + execution (lint, typecheck, test, lighthouse)
  schema.js         # AJV validation of output artifacts
  model-adapter.js  # LLM adapter for summarize
  constants.js      # Policy defaults: maxAttempts=3, maxPatchLines=150, timeCap=20min
  config.js         # Loads quick-gate.config.js or package.json [quick-gate] section
```

Gate resolution: reads target project's `package.json` scripts → matches gate name (lint, typecheck, test) → falls back to sensible defaults (`npx tsc --noEmit`, etc.).

All artifacts written to `.quick-gate/` directory.

## Key Constraints

- ESM only (`"type": "module"`) — use `node:` protocol for all builtins
- Node 18+ required
- Two runtime deps: `ajv` + `ajv-formats` (JSON schema validation)
- Plain JavaScript, no TypeScript compilation
- Tests use Node built-in test runner (`node:test`), no framework deps
- `createRequire(import.meta.url)` for JSON imports (package.json version)

## Gotchas

- npm package name is `quick-gate` but repo name is `quick-gate-js`
- `scripts/` directory contains benchmark tools — excluded from npm via `.npmignore`
- Gate command resolution checks `package.json` scripts first, config second, defaults last
- Repair loop has three abort conditions: no improvement (2x), patch budget (150 lines), time cap (20min)
- `.quick-gate/` output dir should be gitignored in target projects
