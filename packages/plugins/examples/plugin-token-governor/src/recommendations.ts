import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS } from "./constants.js";
import type { GovernorConfig } from "./constants.js";
import type { AgentRecord, AgentMetrics, Recommendation } from "./types.js";
import { isExempt, getManagedAgentIds } from "./gatekeeper.js";

/**
 * Load persisted recommendations from plugin state.
 */
export async function getRecommendations(ctx: PluginContext): Promise<Recommendation[]> {
  const stored = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.recommendations,
  });
  if (Array.isArray(stored)) return stored as Recommendation[];
  return [];
}

async function persistRecommendations(
  ctx: PluginContext,
  recs: Recommendation[],
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: STATE_KEYS.recommendations },
    recs,
  );
}

/**
 * Load persisted agent metrics.
 */
export async function getAgentMetrics(ctx: PluginContext): Promise<AgentMetrics[]> {
  const stored = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.agentMetrics,
  });
  if (Array.isArray(stored)) return stored as AgentMetrics[];
  return [];
}

function rec(
  agent: AgentRecord,
  type: Recommendation["type"],
  severity: Recommendation["severity"],
  title: string,
  description: string,
  estimatedSavingsCents: number,
  autoApplicable: boolean,
): Recommendation {
  return {
    id: randomUUID(),
    agentId: agent.id,
    agentName: agent.name,
    type,
    severity,
    title,
    description,
    estimatedSavingsCents,
    autoApplicable,
    createdAt: new Date().toISOString(),
    dismissedAt: null,
  };
}

/**
 * Analyze all agents and generate recommendations.
 * This is the core analysis engine called by the hourly job.
 */
export async function analyzeAndRecommend(
  ctx: PluginContext,
  config: GovernorConfig,
  agentsById: Map<string, AgentRecord>,
): Promise<{ metrics: AgentMetrics[]; recommendations: Recommendation[] }> {
  const managed = await getManagedAgentIds(ctx);
  const now = new Date();
  const metrics: AgentMetrics[] = [];
  const recommendations: Recommendation[] = [];

  // Preserve dismissed recommendations so we don't regenerate them
  const existingRecs = await getRecommendations(ctx);
  const dismissedKeys = new Set(
    existingRecs
      .filter((r) => r.dismissedAt)
      .map((r) => `${r.agentId}:${r.type}`),
  );

  for (const agent of agentsById.values()) {
    if (agent.status === "terminated") continue;

    const isManaged = managed.has(agent.id);
    const exempt = isExempt(agent, config);

    const runtimeConfig = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
    const heartbeat = (typeof runtimeConfig.heartbeat === "object" && runtimeConfig.heartbeat !== null
      ? runtimeConfig.heartbeat
      : {}) as Record<string, unknown>;
    const intervalSec = typeof heartbeat.intervalSec === "number" ? heartbeat.intervalSec : 0;
    const maxConcurrent = typeof heartbeat.maxConcurrentRuns === "number" ? heartbeat.maxConcurrentRuns : 1;

    // Build basic metrics (limited by what plugin API provides)
    const agentMetric: AgentMetrics = {
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      status: agent.status,
      managed: isManaged,
      totalRuns: 0, // Would need run data - not available via plugin API
      usefulRuns: 0,
      spendCents: agent.spentMonthlyCents ?? 0,
      budgetCents: agent.budgetMonthlyCents,
      cacheHitRatio: null,
      sessionReuseRatio: null,
      wastedTimerSpendCents: 0,
      lastRunAt: agent.lastHeartbeatAt,
      computedAt: now.toISOString(),
    };
    metrics.push(agentMetric);

    // Skip exempt agents for recommendations
    if (exempt) continue;

    const key = (type: Recommendation["type"]) => `${agent.id}:${type}`;

    // Recommendation: Agent not under governor management
    if (!isManaged && agent.status !== "paused") {
      if (!dismissedKeys.has(key("enable_governor"))) {
        const estimatedSavings = intervalSec > 0
          ? Math.round((86400 / intervalSec) * 5) // 5 cents per prevented wakeup per day * 30 days
          : 0;
        recommendations.push(
          rec(
            agent,
            "enable_governor",
            "info",
            `Enroll ${agent.name} in Token Governor`,
            `This agent is not managed by the governor. Enrolling it would make it dormant ` +
            `until called by its manager, preventing unnecessary wakeups.` +
            (intervalSec > 0
              ? ` Currently polling every ${intervalSec}s (~${Math.round(86400 / intervalSec)} wakeups/day).`
              : ""),
            estimatedSavings,
            true,
          ),
        );
      }
    }

    // Recommendation: Timer still active on a managed agent
    if (isManaged && intervalSec > 0) {
      if (!dismissedKeys.has(key("disable_timer"))) {
        const dailyWakeups = Math.round(86400 / intervalSec);
        recommendations.push(
          rec(
            agent,
            "disable_timer",
            "warning",
            `Disable timer heartbeat for ${agent.name}`,
            `Agent is under governor management but still has intervalSec=${intervalSec}. ` +
            `This timer is ineffective (agent is paused) but should be set to 0 for clarity. ` +
            `When not paused, this would generate ~${dailyWakeups} unnecessary wakeups/day.`,
            dailyWakeups * 5,
            false, // Can't modify agent config via plugin API
          ),
        );
      }
    }

    // Recommendation: No budget policy
    if (!agent.budgetMonthlyCents && (agent.spentMonthlyCents ?? 0) > 0) {
      if (!dismissedKeys.has(key("no_budget"))) {
        recommendations.push(
          rec(
            agent,
            "no_budget",
            "warning",
            `Set a budget for ${agent.name}`,
            `Agent has spent $${((agent.spentMonthlyCents ?? 0) / 100).toFixed(2)} this month ` +
            `but has no budget limit. A runaway session could burn unlimited tokens.`,
            0,
            false,
          ),
        );
      }
    }

    // Recommendation: High burn rate (spending > 80% of budget with > 10 days remaining)
    if (agent.budgetMonthlyCents && agent.budgetMonthlyCents > 0) {
      const spent = agent.spentMonthlyCents ?? 0;
      const utilization = spent / agent.budgetMonthlyCents;
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const daysRemaining = daysInMonth - now.getUTCDate();
      if (utilization > 0.8 && daysRemaining > 10) {
        if (!dismissedKeys.has(key("high_burn_rate"))) {
          recommendations.push(
            rec(
              agent,
              "high_burn_rate",
              "critical",
              `${agent.name} is burning budget fast`,
              `Already at ${Math.round(utilization * 100)}% of monthly budget ` +
              `($${(spent / 100).toFixed(2)} / $${(agent.budgetMonthlyCents / 100).toFixed(2)}) ` +
              `with ${daysRemaining} days remaining. Will likely hit hard stop before month end.`,
              0,
              false,
            ),
          );
        }
      }
    }

    // Recommendation: Over-provisioned concurrency
    if (maxConcurrent > 1) {
      if (!dismissedKeys.has(key("lower_concurrency"))) {
        recommendations.push(
          rec(
            agent,
            "lower_concurrency",
            "info",
            `Reduce concurrent runs for ${agent.name}`,
            `Agent has maxConcurrentRuns=${maxConcurrent} but most agents work ` +
            `sequentially. Each concurrent run is a separate LLM invocation with separate token cost.`,
            0,
            false,
          ),
        );
      }
    }

    // Recommendation: Stale agent (no activity in 7+ days, not paused by governor)
    if (!isManaged && agent.lastHeartbeatAt) {
      const lastRun = new Date(agent.lastHeartbeatAt);
      const daysSinceRun = (now.getTime() - lastRun.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceRun > 7 && agent.status !== "paused") {
        if (!dismissedKeys.has(key("stale_agent"))) {
          recommendations.push(
            rec(
              agent,
              "stale_agent",
              "info",
              `${agent.name} has been idle for ${Math.floor(daysSinceRun)} days`,
              `No activity since ${lastRun.toISOString().split("T")[0]}. ` +
              `Consider enrolling in Token Governor or pausing manually.`,
              intervalSec > 0 ? Math.round((86400 / intervalSec) * 5 * 7) : 0,
              true,
            ),
          );
        }
      }
    }
  }

  // Persist
  await ctx.state.set(
    { scopeKind: "instance", stateKey: STATE_KEYS.agentMetrics },
    metrics,
  );
  // Merge with existing dismissed recommendations
  const merged = [
    ...recommendations,
    ...existingRecs.filter((r) => r.dismissedAt),
  ];
  await persistRecommendations(ctx, merged);

  return { metrics, recommendations };
}

/**
 * Dismiss a recommendation by ID.
 */
export async function dismissRecommendation(
  ctx: PluginContext,
  recommendationId: string,
): Promise<boolean> {
  const recs = await getRecommendations(ctx);
  const target = recs.find((r) => r.id === recommendationId);
  if (!target) return false;
  target.dismissedAt = new Date().toISOString();
  await persistRecommendations(ctx, recs);
  return true;
}
