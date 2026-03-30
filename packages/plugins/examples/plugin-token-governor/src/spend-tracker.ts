import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS } from "./constants.js";
import type { SavingsData } from "./types.js";

const EMPTY_SAVINGS: SavingsData = {
  preventedWakeups: 0,
  estimatedSavingsCents: 0,
  rejectedWakeups: 0,
  completedRuns: 0,
  periodStart: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/**
 * Estimated cost per wasted heartbeat in cents.
 * Based on a typical Claude Sonnet run: ~$0.03-0.10 depending on context size.
 * We use a conservative estimate of 5 cents per prevented wakeup.
 */
const ESTIMATED_COST_PER_WAKEUP_CENTS = 5;

export async function getSavings(ctx: PluginContext): Promise<SavingsData> {
  const stored = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.savings,
  });
  if (stored && typeof stored === "object") {
    return { ...EMPTY_SAVINGS, ...(stored as SavingsData) };
  }
  return { ...EMPTY_SAVINGS };
}

async function persistSavings(ctx: PluginContext, savings: SavingsData): Promise<void> {
  savings.updatedAt = new Date().toISOString();
  await ctx.state.set(
    { scopeKind: "instance", stateKey: STATE_KEYS.savings },
    savings,
  );
}

/**
 * Record a prevented wakeup (rejected by policy).
 */
export async function recordPreventedWakeup(ctx: PluginContext): Promise<void> {
  const savings = await getSavings(ctx);
  savings.preventedWakeups += 1;
  savings.rejectedWakeups += 1;
  savings.estimatedSavingsCents += ESTIMATED_COST_PER_WAKEUP_CENTS;
  await persistSavings(ctx, savings);
}

/**
 * Record a completed managed run.
 */
export async function recordCompletedRun(
  ctx: PluginContext,
  costCents: number | null,
): Promise<void> {
  const savings = await getSavings(ctx);
  savings.completedRuns += 1;
  await persistSavings(ctx, savings);
}

/**
 * Record timer wakeups prevented by having the agent paused.
 * Called during reconciliation when we detect an agent would have
 * been woken by timer but was paused.
 */
export async function recordTimerPrevention(
  ctx: PluginContext,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  const savings = await getSavings(ctx);
  savings.preventedWakeups += count;
  savings.estimatedSavingsCents += count * ESTIMATED_COST_PER_WAKEUP_CENTS;
  await persistSavings(ctx, savings);
}

/**
 * Reset savings for a new tracking period (e.g., monthly).
 */
export async function resetSavingsPeriod(ctx: PluginContext): Promise<void> {
  const fresh: SavingsData = {
    ...EMPTY_SAVINGS,
    periodStart: new Date().toISOString(),
  };
  await persistSavings(ctx, fresh);
}
