// Internal runtime limits (PLAN.md -> Execution engine -> Runtime limits).
// These are internal runtime limits, not a claim that remote commands finish
// within them.

export interface RuntimeLimits {
  sliceBudgetMs: number;
  externalAttemptBudgetMs: number;
  cancellationGraceMs: number;
  recoveryWakeIntervalMs: number;
  outputFlushIntervalMs: number;
  maxModelAttempts: number;
  maxSafeToolRetries: number;
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  sliceBudgetMs: 600_000,
  externalAttemptBudgetMs: 540_000,
  cancellationGraceMs: 10_000,
  recoveryWakeIntervalMs: 30_000,
  outputFlushIntervalMs: 100,
  maxModelAttempts: 3,
  maxSafeToolRetries: 2,
};
