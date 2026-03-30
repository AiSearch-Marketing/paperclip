import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginEvent,
  type PluginJobContext,
} from "@paperclipai/plugin-sdk";
import { JOB_KEYS, STREAM_CHANNELS } from "./constants.js";
import type { GovernorConfig } from "./constants.js";
import type { AgentRecord } from "./types.js";
import {
  getConfig,
  getManagedAgentIds,
  setManagedAgentIds,
  loadAgentMap,
  isExempt,
  isActorAllowedToWake,
  enrollAgent,
  wakeAgent,
  rePauseAgent,
  initialEnrollment,
} from "./gatekeeper.js";
import { extractMentionedAgentIds, buildAgentNameMap } from "./mention-detector.js";
import { appendWakeLog, getWakeLog } from "./wake-log.js";
import {
  getSavings,
  recordPreventedWakeup,
  recordCompletedRun,
  recordTimerPrevention,
} from "./spend-tracker.js";
import {
  analyzeAndRecommend,
  dismissRecommendation,
  getRecommendations,
  getAgentMetrics,
} from "./recommendations.js";

/**
 * Track which agent runs are "ours" — runs we initiated via wakeAgent().
 * When these runs complete, we re-pause the agent.
 * Map of agentId → { companyId, startedAt }
 */
const activeGovernedRuns = new Map<string, { companyId: string; startedAt: string }>();

let pluginCtx: PluginContext | null = null;

// ──────────────────────────────────────────────────────────
// Event Handlers
// ──────────────────────────────────────────────────────────

/**
 * Handle issue.created and issue.updated events.
 * If an issue is assigned to a managed agent, check wake policy and act.
 */
async function handleIssueEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const config = await getConfig(ctx);
  const companyId = event.companyId;
  if (!companyId || !event.entityId) return;

  // The event payload only contains { title, identifier }, not the assignee.
  // Fetch the full issue to get the assigneeAgentId.
  let issue: Record<string, unknown>;
  try {
    issue = (await ctx.issues.get(event.entityId, companyId)) as unknown as Record<string, unknown>;
  } catch {
    return; // Issue not found or not accessible
  }

  const assigneeAgentId =
    typeof issue.assigneeAgentId === "string" ? issue.assigneeAgentId : null;
  if (!assigneeAgentId) return;

  const managed = await getManagedAgentIds(ctx);
  if (!managed.has(assigneeAgentId)) return;

  const agentsById = await loadAgentMap(ctx, companyId);
  const target = agentsById.get(assigneeAgentId);
  if (!target) return;

  // Determine who made the assignment
  const actorId = event.actorId ?? null;
  const actorType = (event.actorType ?? "system") as "agent" | "user" | "system";

  const { allowed, reason } = isActorAllowedToWake({
    actorId,
    actorType,
    targetAgentId: assigneeAgentId,
    agentsById,
    config,
  });

  if (allowed) {
    const issueId = event.entityId ?? null;
    const woken = await wakeAgent(ctx, target, `governor:assignment:${reason}`);
    if (woken) {
      activeGovernedRuns.set(assigneeAgentId, {
        companyId,
        startedAt: new Date().toISOString(),
      });
    }
    await appendWakeLog(ctx, {
      agentId: assigneeAgentId,
      agentName: target.name,
      action: woken ? "approved" : "rejected",
      reason: woken ? `Assignment approved (${reason})` : `Resume failed`,
      actorId,
      actorType,
      issueId,
      costCents: null,
      tokenCount: null,
      durationMs: null,
    }, config);

    // Emit to stream for live UI updates
    ctx.streams.emit(STREAM_CHANNELS.wakeLog, {
      action: "approved",
      agentId: assigneeAgentId,
      agentName: target.name,
      companyId,
      reason,
    });
  } else {
    await recordPreventedWakeup(ctx);
    await appendWakeLog(ctx, {
      agentId: assigneeAgentId,
      agentName: target.name,
      action: "rejected",
      reason: `Assignment rejected (${reason})`,
      actorId,
      actorType,
      issueId: event.entityId ?? null,
      costCents: null,
      tokenCount: null,
      durationMs: null,
    }, config);

    ctx.streams.emit(STREAM_CHANNELS.wakeLog, {
      action: "rejected",
      agentId: assigneeAgentId,
      agentName: target.name,
      companyId,
      reason,
    });
  }
}

/**
 * Handle issue.comment.created events.
 * If a comment @mentions a managed agent, wake it.
 */
async function handleCommentEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const config = await getConfig(ctx);
  if (!config.allowMentionWakes) return;

  const companyId = event.companyId;
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload || !companyId) return;

  // Try to get comment body from the event payload
  const body = typeof payload.body === "string" ? payload.body : "";
  if (!body) return;

  const managed = await getManagedAgentIds(ctx);
  const agentsById = await loadAgentMap(ctx, companyId);
  const agentsByName = buildAgentNameMap(agentsById);
  const mentionedIds = extractMentionedAgentIds(body, agentsByName);

  for (const agentId of mentionedIds) {
    if (!managed.has(agentId)) continue;

    const target = agentsById.get(agentId);
    if (!target) continue;

    const woken = await wakeAgent(ctx, target, "governor:mention");
    if (woken) {
      activeGovernedRuns.set(agentId, {
        companyId,
        startedAt: new Date().toISOString(),
      });
    }
    await appendWakeLog(ctx, {
      agentId,
      agentName: target.name,
      action: woken ? "approved" : "rejected",
      reason: woken ? "@mentioned in comment" : "Mention wake failed",
      actorId: event.actorId ?? null,
      actorType: (event.actorType ?? "system") as "agent" | "user" | "system",
      issueId: event.entityId ?? null,
      costCents: null,
      tokenCount: null,
      durationMs: null,
    }, config);
  }
}

/**
 * Handle agent.run.finished, agent.run.failed, agent.run.cancelled events.
 * If this is a governed run, re-pause the agent.
 */
async function handleRunCompleted(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const config = await getConfig(ctx);
  const payload = event.payload as Record<string, unknown> | null;
  const agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
  if (!agentId) return;

  const companyId = event.companyId;
  if (!companyId) return;

  const governed = activeGovernedRuns.get(agentId);
  if (!governed) return;

  // Calculate duration
  const startedAt = governed.startedAt;
  const durationMs = new Date().getTime() - new Date(startedAt).getTime();

  // Remove from active tracking
  activeGovernedRuns.delete(agentId);

  // Re-pause the agent
  const managed = await getManagedAgentIds(ctx);
  if (managed.has(agentId)) {
    // Small delay to allow the agent's status to settle to "idle"
    setTimeout(async () => {
      try {
        await rePauseAgent(ctx, agentId, companyId);
        const agentsById = await loadAgentMap(ctx, companyId);
        const agent = agentsById.get(agentId);
        await appendWakeLog(ctx, {
          agentId,
          agentName: agent?.name ?? "Unknown",
          action: "completed",
          reason: `Run ${event.eventType.split(".").pop()} — re-paused`,
          actorId: null,
          actorType: "system",
          issueId: null,
          costCents: null,
          tokenCount: null,
          durationMs,
        }, config);

        await recordCompletedRun(ctx, null);
      } catch {
        // Best-effort re-pause; reconciliation job will catch stragglers
      }
    }, 3000);
  }
}

/**
 * Handle agent.created events.
 * Auto-enroll new agents if configured.
 */
async function handleAgentCreated(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const config = await getConfig(ctx);
  if (!config.autoManageNewAgents) return;

  const companyId = event.companyId;
  if (!companyId) return;

  const agentId = event.entityId;
  if (!agentId) return;

  const agentsById = await loadAgentMap(ctx, companyId);
  const agent = agentsById.get(agentId);
  if (!agent) return;

  if (isExempt(agent, config)) return;

  const managed = await getManagedAgentIds(ctx);
  if (managed.has(agentId)) return;

  await enrollAgent(ctx, agent, managed);
  await setManagedAgentIds(ctx, managed);

  await appendWakeLog(ctx, {
    agentId,
    agentName: agent.name,
    action: "auto_paused",
    reason: "New agent auto-enrolled by Token Governor",
    actorId: null,
    actorType: "system",
    issueId: null,
    costCents: null,
    tokenCount: null,
    durationMs: null,
  }, config);
}

/**
 * Handle cost_event.created for real-time spend tracking.
 */
async function handleCostEvent(_ctx: PluginContext, _event: PluginEvent): Promise<void> {
  // Currently a no-op placeholder. Cost tracking via the savings module
  // uses aggregated data from the analysis job rather than per-event tracking.
  // This handler exists for future real-time spend alerts.
}

// ──────────────────────────────────────────────────────────
// Jobs
// ──────────────────────────────────────────────────────────

/**
 * Reconciliation job: runs every minute.
 * Ensures managed agents that should be paused are actually paused.
 */
async function reconcileJob(ctx: PluginContext): Promise<void> {
  const config = await getConfig(ctx);

  // We need at least one company. List companies and process each.
  const companies = await ctx.companies.list({ limit: 50, offset: 0 });

  for (const company of companies) {
    const companyId = (company as { id: string }).id;
    const agentsById = await loadAgentMap(ctx, companyId);
    const managed = await getManagedAgentIds(ctx);
    let timerPreventions = 0;

    for (const agentId of managed) {
      const agent = agentsById.get(agentId);
      if (!agent) {
        // Agent was deleted; remove from management
        managed.delete(agentId);
        continue;
      }

      // Skip if exempt (config may have changed)
      if (isExempt(agent, config)) {
        managed.delete(agentId);
        continue;
      }

      // Skip terminated agents
      if (agent.status === "terminated") {
        managed.delete(agentId);
        continue;
      }

      // If agent is idle (not paused, not running), re-pause it.
      // Clear stale activeGovernedRuns entries for idle agents — the run
      // completion event may have been missed.
      if (agent.status === "idle") {
        activeGovernedRuns.delete(agentId);
        await rePauseAgent(ctx, agentId, companyId);
        await appendWakeLog(ctx, {
          agentId,
          agentName: agent.name,
          action: "reconciled",
          reason: "Agent was idle but should be paused — reconciled",
          actorId: null,
          actorType: "system",
          issueId: null,
          costCents: null,
          tokenCount: null,
          durationMs: null,
        }, config);
      }

      // Count timer preventions: if agent has intervalSec > 0, each minute
      // it's paused prevents potential wakeups
      const runtimeConfig = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
      const heartbeat = (typeof runtimeConfig.heartbeat === "object" && runtimeConfig.heartbeat !== null
        ? runtimeConfig.heartbeat
        : {}) as Record<string, unknown>;
      const intervalSec = typeof heartbeat.intervalSec === "number" ? heartbeat.intervalSec : 0;
      if (intervalSec > 0 && agent.status === "paused") {
        // Roughly: 60 seconds / intervalSec = wakeups prevented per minute
        timerPreventions += Math.max(1, Math.floor(60 / intervalSec));
      }
    }

    await setManagedAgentIds(ctx, managed);
    if (timerPreventions > 0) {
      await recordTimerPrevention(ctx, timerPreventions);
    }
  }
}

/**
 * Analysis job: runs every hour.
 * Computes efficiency metrics and generates recommendations.
 */
async function analyzeJob(ctx: PluginContext): Promise<void> {
  const config = await getConfig(ctx);
  const companies = await ctx.companies.list({ limit: 50, offset: 0 });

  for (const company of companies) {
    const companyId = (company as { id: string }).id;
    const agentsById = await loadAgentMap(ctx, companyId);
    await analyzeAndRecommend(ctx, config, agentsById);
  }
}

// ──────────────────────────────────────────────────────────
// Data Handlers (called by UI via bridge)
// ──────────────────────────────────────────────────────────

function registerDataHandlers(ctx: PluginContext): void {
  ctx.data.register("overview", async (params) => {
    const companyId = typeof params.companyId === "string" ? params.companyId : "";
    if (!companyId) return null;

    const config = await getConfig(ctx);
    const managed = await getManagedAgentIds(ctx);
    const agentsById = await loadAgentMap(ctx, companyId);
    const savings = await getSavings(ctx);
    const wakeLog = await getWakeLog(ctx);
    const recommendations = await getRecommendations(ctx);
    const metrics = await getAgentMetrics(ctx);

    // Build agent summaries
    const agentSummaries = [];
    for (const agent of agentsById.values()) {
      if (agent.status === "terminated") continue;
      const exempt = isExempt(agent, config);
      agentSummaries.push({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
        managed: managed.has(agent.id),
        exempt,
        activeRun: activeGovernedRuns.has(agent.id),
        lastHeartbeatAt: agent.lastHeartbeatAt,
        spentMonthlyCents: agent.spentMonthlyCents,
        budgetMonthlyCents: agent.budgetMonthlyCents,
      });
    }

    return {
      config,
      agents: agentSummaries,
      managedCount: managed.size,
      exemptCount: agentSummaries.filter((a) => a.exempt).length,
      activeRunCount: activeGovernedRuns.size,
      savings,
      wakeLog: wakeLog.slice(0, 50), // Latest 50 entries for UI
      recommendations: recommendations.filter((r) => !r.dismissedAt),
      metrics,
    };
  });

  ctx.data.register("wake-log", async () => {
    return await getWakeLog(ctx);
  });

  ctx.data.register("savings", async () => {
    return await getSavings(ctx);
  });

  ctx.data.register("recommendations", async () => {
    const recs = await getRecommendations(ctx);
    return recs.filter((r) => !r.dismissedAt);
  });

  ctx.data.register("agent-metrics", async () => {
    return await getAgentMetrics(ctx);
  });
}

// ──────────────────────────────────────────────────────────
// Action Handlers (called by UI via bridge)
// ──────────────────────────────────────────────────────────

function registerActionHandlers(ctx: PluginContext): void {
  /** Enroll a specific agent under governor management. */
  ctx.actions.register("enroll-agent", async (params) => {
    const agentId = typeof params.agentId === "string" ? params.agentId : "";
    const companyId = typeof params.companyId === "string" ? params.companyId : "";
    if (!agentId || !companyId) return { ok: false, error: "Missing agentId or companyId" };

    const agentsById = await loadAgentMap(ctx, companyId);
    const agent = agentsById.get(agentId);
    if (!agent) return { ok: false, error: "Agent not found" };

    const managed = await getManagedAgentIds(ctx);
    await enrollAgent(ctx, agent, managed);
    await setManagedAgentIds(ctx, managed);

    const config = await getConfig(ctx);
    await appendWakeLog(ctx, {
      agentId,
      agentName: agent.name,
      action: "auto_paused",
      reason: "Manually enrolled via Token Governor UI",
      actorId: null,
      actorType: "user",
      issueId: null,
      costCents: null,
      tokenCount: null,
      durationMs: null,
    }, config);

    return { ok: true };
  });

  /** Remove an agent from governor management and resume it. */
  ctx.actions.register("unenroll-agent", async (params) => {
    const agentId = typeof params.agentId === "string" ? params.agentId : "";
    const companyId = typeof params.companyId === "string" ? params.companyId : "";
    if (!agentId || !companyId) return { ok: false, error: "Missing agentId or companyId" };

    const agentsById = await loadAgentMap(ctx, companyId);
    const agent = agentsById.get(agentId);
    if (!agent) return { ok: false, error: "Agent not found" };

    const managed = await getManagedAgentIds(ctx);
    managed.delete(agentId);
    await setManagedAgentIds(ctx, managed);

    // Resume if paused
    if (agent.status === "paused") {
      try {
        await ctx.agents.resume(agentId, companyId);
      } catch { /* may not be pausable */ }
    }

    const config = await getConfig(ctx);
    await appendWakeLog(ctx, {
      agentId,
      agentName: agent.name,
      action: "auto_resumed",
      reason: "Removed from governor management via UI",
      actorId: null,
      actorType: "user",
      issueId: null,
      costCents: null,
      tokenCount: null,
      durationMs: null,
    }, config);

    return { ok: true };
  });

  /** Force-wake a managed agent (bypasses policy). */
  ctx.actions.register("force-wake", async (params) => {
    const agentId = typeof params.agentId === "string" ? params.agentId : "";
    const companyId = typeof params.companyId === "string" ? params.companyId : "";
    if (!agentId || !companyId) return { ok: false, error: "Missing agentId or companyId" };

    const agentsById = await loadAgentMap(ctx, companyId);
    const agent = agentsById.get(agentId);
    if (!agent) return { ok: false, error: "Agent not found" };

    const woken = await wakeAgent(ctx, agent, "governor:force_wake");
    if (woken) {
      activeGovernedRuns.set(agentId, {
        companyId,
        startedAt: new Date().toISOString(),
      });
    }

    const config = await getConfig(ctx);
    await appendWakeLog(ctx, {
      agentId,
      agentName: agent.name,
      action: woken ? "approved" : "rejected",
      reason: "Force wake via UI",
      actorId: null,
      actorType: "user",
      issueId: null,
      costCents: null,
      tokenCount: null,
      durationMs: null,
    }, config);

    return { ok: woken };
  });

  /** Dismiss a recommendation. */
  ctx.actions.register("dismiss-recommendation", async (params) => {
    const recommendationId = typeof params.recommendationId === "string"
      ? params.recommendationId
      : "";
    if (!recommendationId) return { ok: false, error: "Missing recommendationId" };
    const dismissed = await dismissRecommendation(ctx, recommendationId);
    return { ok: dismissed };
  });

  /** Run initial enrollment for a company. */
  ctx.actions.register("run-enrollment", async (params) => {
    const companyId = typeof params.companyId === "string" ? params.companyId : "";
    if (!companyId) return { ok: false, error: "Missing companyId" };
    const result = await initialEnrollment(ctx, companyId);
    return { ok: true, ...result };
  });
}

// ──────────────────────────────────────────────────────────
// Plugin Definition
// ──────────────────────────────────────────────────────────

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx: PluginContext) {
    pluginCtx = ctx;

    // Register data and action handlers for UI bridge
    registerDataHandlers(ctx);
    registerActionHandlers(ctx);

    // Register event subscriptions
    ctx.events.on("issue.created", (event) => handleIssueEvent(ctx, event));
    ctx.events.on("issue.updated", (event) => handleIssueEvent(ctx, event));
    ctx.events.on("issue.comment.created", (event) => handleCommentEvent(ctx, event));
    ctx.events.on("agent.run.finished", (event) => handleRunCompleted(ctx, event));
    ctx.events.on("agent.run.failed", (event) => handleRunCompleted(ctx, event));
    ctx.events.on("agent.run.cancelled", (event) => handleRunCompleted(ctx, event));
    ctx.events.on("agent.created", (event) => handleAgentCreated(ctx, event));
    ctx.events.on("cost_event.created", (event) => handleCostEvent(ctx, event));

    // Register scheduled jobs
    ctx.jobs.register(JOB_KEYS.reconcile, async (_job: PluginJobContext) => {
      await reconcileJob(ctx);
    });
    ctx.jobs.register(JOB_KEYS.analyze, async (_job: PluginJobContext) => {
      await analyzeJob(ctx);
    });

    // Run initial enrollment on startup
    try {
      const companies = await ctx.companies.list({ limit: 50, offset: 0 });
      for (const company of companies) {
        const companyId = (company as { id: string }).id;
        await initialEnrollment(ctx, companyId);
      }
    } catch (err) {
      // Non-fatal: reconciliation job will catch up
    }
  },

  async onHealth() {
    const managed = pluginCtx ? await getManagedAgentIds(pluginCtx) : new Set();
    return {
      status: "ok",
      message: `Managing ${managed.size} agents, ${activeGovernedRuns.size} active runs`,
      details: {
        managedAgents: managed.size,
        activeRuns: activeGovernedRuns.size,
      },
    };
  },

  async onConfigChanged() {
    // Re-run enrollment when config changes (exempt lists may have changed)
    if (!pluginCtx) return;
    try {
      const companies = await pluginCtx.companies.list({ limit: 50, offset: 0 });
      for (const company of companies) {
        const companyId = (company as { id: string }).id;
        await initialEnrollment(pluginCtx, companyId);
      }
    } catch {
      // Best effort
    }
  },

  async onShutdown() {
    // Resume all managed agents on plugin shutdown so they're not stuck paused
    if (!pluginCtx) return;
    try {
      const managed = await getManagedAgentIds(pluginCtx);
      const companies = await pluginCtx.companies.list({ limit: 50, offset: 0 });
      for (const company of companies) {
        const companyId = (company as { id: string }).id;
        const agentsById = await loadAgentMap(pluginCtx, companyId);
        for (const agentId of managed) {
          const agent = agentsById.get(agentId);
          if (agent?.status === "paused") {
            try {
              await pluginCtx.agents.resume(agentId, companyId);
            } catch { /* best effort */ }
          }
        }
      }
    } catch {
      // Best effort — agents can be resumed manually
    }
    pluginCtx = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
