# Canary Scope + Full Fallback Design Note (Do Not Rush)

Date: 2026-02-21
Status: Design only

## Goal
Reduce time-to-signal in canary mode while preserving deterministic trust, and escalate intelligently to full mode when canary fails in ways that are ambiguous or flaky.

## Non-goals
- No heuristics that allow agent to self-certify pass/fail.
- No broad framework abstraction in this phase.
- No silent auto-merging behavior.

## Proposed behavior
1. Build a deterministic scope map from changed files to impacted routes.
2. Run canary checks on that scoped surface first.
3. If canary fails, classify failure type.
4. Auto-run full mode when failure class indicates uncertainty/high blast radius.
5. Emit explicit reason for full fallback in metadata.

## Scope mapping strategy (Next.js)
- `app/**/page.tsx|js|mdx` -> route path.
- `app/**/layout.tsx|js` -> all descendant routes.
- `components/**` -> reverse-import graph to route entry points.
- Shared config (`next.config.*`, `tsconfig.*`, lint config, package lockfiles) -> treat as global impact.

## Fallback-to-full triggers
- Build/typecheck failure in canary.
- Lighthouse runtime error (server 5xx, navigation error, timeout).
- Shared-config change detected.
- Canary result contradicts prior stable baseline (optional once baseline exists).

## Metadata additions
- `canary_scope.routes`
- `canary_scope.reasoning`
- `fallback_to_full.triggered`
- `fallback_to_full.reason_code`
- `fallback_to_full.evidence`

## Guardrails
- Keep full-mode fallback deterministic and auditable.
- Preserve bounded runtime caps.
- Never mark pass based on inference.

## Rollout plan
1. Implement route mapper for `app/` only.
2. Add conservative global-impact detector.
3. Add fallback trigger rules above.
4. Add fixture tests for changed-file -> route mapping.
5. Add integration tests for fallback behavior.

## Risks
- Import graph inaccuracies can under-scope routes.
- Over-scoping can erase canary speed benefit.
- Flaky lighthouse failures can over-trigger full runs.

## Test plan
- Unit: file-path -> route mapping cases.
- Unit: fallback trigger decision table.
- Integration: canary fail from lighthouse runtime error triggers full.
- Integration: local component-only change scopes correctly.
- Regression: deterministic pass/fail source remains gate outputs.

## Two-pass self-evaluation (fallback for unavailable personal split skill)
Pass A (skeptical):
- Mapping from shared components to routes is error-prone without robust graph extraction.
- Fallback triggers could be too broad initially and increase runtime.

Pass B (pragmatic):
- Start conservative: if uncertain, escalate to full.
- Ship with explicit telemetry and tighten rules based on observed false-trigger rate.

Decision:
- Proceed as phased implementation only, with fixture coverage before enabling default full fallback.
