# AGENTS.md

## Commands

- `npm install` -- Install dependencies
- `node --test test/*.test.js` -- Run all 44 tests
- `node --test test/gates.test.js` -- Single test file
- `npm run test` -- Same as above via npm script
- `npx quick-gate run` -- Run all quality gates
- `npx quick-gate repair --max-attempts 3` -- Auto-fix lint failures
- `npx quick-gate summarize` -- Generate agent brief

## Testing

- Framework: Node.js built-in test runner (`node:test` + `node:assert`)
- Test location: `test/`, named `*.test.js`
- All tests run offline — subprocess execution is mocked
- No test framework dependency — uses Node 18+ native test runner
- Run single test: `node --test test/gates.test.js`

## Project Structure

```
src/
  cli.js                # Entry point, argument parsing, subcommand dispatch
  run-command.js        # `quick-gate run` — orchestrates gate execution
  repair-command.js     # `quick-gate repair` — bounded auto-fix loop
  summarize-command.js  # `quick-gate summarize` — agent brief generation
  gates.js              # Gate implementations (lint, typecheck, test, lighthouse)
  schema.js             # AJV-based JSON schema validation
  model-adapter.js      # LLM model adapter for summarize command
  config.js             # Config loading (quick-gate.config.js / package.json)
  constants.js          # Exit codes, default policy, escalation codes
  exec.js               # Child process execution wrapper
  env-check.js          # Environment detection (CI, tool availability)
  fs-utils.js           # File operations (artifact writes to .quick-gate/)
  deterministic-prefix.js  # Deterministic lint fix prefix generation
schemas/
  failures.schema.json     # JSON schema for gate failure output
  agent-brief.schema.json  # JSON schema for summarize output
test/                      # Tests (node:test)
scripts/                   # Benchmark scripts (not published to npm)
```

Gate resolution: reads `package.json` scripts → matches gate name → falls back to defaults (e.g., `npx tsc --noEmit` for typecheck).

## Code Style

- ESM modules (`import`/`export`, `"type": "module"` in package.json)
- Node 18+ only — use `node:` protocol for builtins (`node:fs`, `node:path`, etc.)
- No TypeScript — plain JavaScript with JSDoc comments where helpful
- Two runtime dependencies only: `ajv` + `ajv-formats` (schema validation)
- Version read dynamically from package.json via `createRequire`:

Good:
```js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
```

Bad:
```js
// No hardcoded versions
const VERSION = '0.2.0';

// No CommonJS
const fs = require('fs');
```

Function and file naming: kebab-case for filenames (`run-command.js`), camelCase for functions (`resolveGateCommand`).

## Git Workflow

- Branch from `main`
- Conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `chore:`
- Run `node --test test/*.test.js` before pushing
- JSON schemas in `schemas/` must stay in sync with validation logic in `schema.js`

## Boundaries

**Always:**
- Run tests after modifying source files
- Use ESM imports with `node:` protocol for builtins
- Maintain Node 18 compatibility
- Keep runtime deps minimal (ajv + ajv-formats only)
- Write artifacts to `.quick-gate/` directory

**Ask first:**
- Adding new runtime dependencies
- Adding new gate types
- Changing escalation codes in `constants.js`
- Modifying the repair loop policy defaults
- Changing artifact output format (breaks downstream consumers)

**Never:**
- Use CommonJS `require()` in source files (except `createRequire` for JSON imports)
- Add TypeScript compilation — this is intentionally plain JS
- Execute real subprocesses in tests
- Commit `.quick-gate/` output directory
- Break JSON schema backward compatibility without a version bump
