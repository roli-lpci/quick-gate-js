# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-02-25

### Added
- Four quality gates: lint (ESLint), typecheck (tsc), build, and Lighthouse
- Bounded auto-repair loop with optional LLM-assisted patches via Ollama
- Machine-readable escalation evidence (`.quick-gate/escalation.json`)
- Changed-files mode for fast PR feedback
- Canary and enforce modes
- Broadened from Next.js-only to all TypeScript/ESLint projects
