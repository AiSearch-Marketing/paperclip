import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { GovernorConfig } from "./constants.js";
import type { AgentRecord } from "./types.js";
import { DEFAULT_CONFIG } from "./constants.js";

/**
 * Determine whether an agent should be exempt from governor management.
 */
export function isExempt(agent: AgentRecord, config: GovernorConfig): boolean {
  if (config.exemptAgentIds.includes(agent.id)) return true;
  if (agent.role && config.exemptRoles.includes(agent.role)) return true;
  return false;
}

/**
 * Build the full chain of command for an agent (walking up reportsTo).
 * Returns an array of agent IDs from direct manager up to the root (CEO).
 */
export function buildChainOfCommand(
  agentId: string,
  agentsById: Map<string, AgentRecord>,
): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current = agentsById.get(agentId);
  if (!current) return chain;

  let managerId = current.reportsTo;
  while (managerId && !visited.has(managerId)) {
    visited.add(managerId);
    chain.push(managerId);
    const manager = agentsById.get(managerId);
    if (!manager) break;
    managerId = manager.reportsTo;
  }
  return chain;
}

/**
 * Check whether an actor is allowed to wake a managed agent
 * based on the configured wake policy.
 */
export function isActorAllowedToWake(input: {
  actorId: string | null;
  actorType: "agent" | "user" | "system";
  targetAgentId: string;
  agentsById: Map<string, AgentRecord>;
  config: GovernorConfig;
}): { allowed: boolean; reason: string } {
  const { actorId, actorType, targetAgentId, agentsById, config } = input;

  // Human users can always wake if configured
  if (actorType === "user" && config.allowDirectUserWakes) {
    return { allowed: true, reason: "direct_user_wake" };
  }

  // System actions (e.g., process recovery) are always allowed
  if (actorType === "system") {
    return { allowed: true, reason: "system_action" };
  }

  // No actor ID means we can't check — default to the policy
  if (!actorId) {
    if (config.wakePolicy === "anyone") {
      return { allowed: true, reason: "policy_anyone" };
    }
    return { allowed: false, reason: "no_actor_id" };
  }

  if (config.wakePolicy === "anyone") {
    return { allowed: true, reason: "policy_anyone" };
  }

  const chain = buildChainOfCommand(targetAgentId, agentsById);

  if (config.wakePolicy === "direct_manager") {
    const target = agentsById.get(targetAgentId);
    if (target?.reportsTo === actorId) {
      return { allowed: true, reason: "direct_manager" };
    }
    return { allowed: false, reason: "not_direct_manager" };
  }

  // chain_of_command: actor must be in the agent's management chain
  if (chain.includes(actorId)) {
    return { allowed: true, reason: "chain_of_command" };
  }

  return { allowed: false, reason: "not_in_chain_of_command" };
}

/**
 * Load all agents for a company and build a lookup map.
 */
export async function loadAgentMap(
  ctx: PluginContext,
  companyId: string,
): Promise<Map<string, AgentRecord>> {
  const agents = (await ctx.agents.list({
    companyId,
    limit: 500,
    offset: 0,
  })) as AgentRecord[];
  const map = new Map<string, AgentRecord>();
  for (const agent of agents) {
    map.set(agent.id, agent);
  }
  return map;
}

/**
 * Get merged config with defaults.
 */
export async function getConfig(ctx: PluginContext): Promise<GovernorConfig> {
  const raw = await ctx.config.get();
  return {
    ...DEFAULT_CONFIG,
    ...(raw as Partial<GovernorConfig>),
  };
}

/**
 * Get the set of managed agent IDs from plugin state.
 */
export async function getManagedAgentIds(ctx: PluginContext): Promise<Set<string>> {
  const stored = await ctx.state.get({
    scopeKind: "instance",
    stateKey: "managed-agents",
  });
  if (Array.isArray(stored)) return new Set(stored as string[]);
  return new Set();
}

/**
 * Persist the set of managed agent IDs.
 */
export async function setManagedAgentIds(
  ctx: PluginContext,
  ids: Set<string>,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: "managed-agents" },
    [...ids],
  );
}

/**
 * Enroll an agent under governor management: pause it and add to managed set.
 */
export async function enrollAgent(
  ctx: PluginContext,
  agent: AgentRecord,
  managed: Set<string>,
): Promise<void> {
  managed.add(agent.id);
  // Only pause if the agent is currently idle (don't interrupt running agents)
  if (agent.status === "idle") {
    try {
      await ctx.agents.pause({ agentId: agent.id, companyId: agent.companyId });
    } catch {
      // Agent may already be paused or in a non-pausable state
    }
  }
}

/**
 * Remove an agent from governor management and resume it.
 */
export async function unenrollAgent(
  ctx: PluginContext,
  agent: AgentRecord,
  managed: Set<string>,
): Promise<void> {
  managed.delete(agent.id);
  if (agent.status === "paused") {
    try {
      await ctx.agents.resume({ agentId: agent.id, companyId: agent.companyId });
    } catch {
      // Agent may not be in a resumable state
    }
  }
}

/**
 * Resume a managed agent for work, invoke it, and track it.
 * Returns true if the agent was successfully woken.
 */
export async function wakeAgent(
  ctx: PluginContext,
  agent: AgentRecord,
  reason: string,
): Promise<boolean> {
  try {
    // Resume the agent first
    if (agent.status === "paused") {
      await ctx.agents.resume({ agentId: agent.id, companyId: agent.companyId });
    }
    // Invoke it with the wake reason
    await ctx.agents.invoke({
      agentId: agent.id,
      companyId: agent.companyId,
      reason,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-pause a managed agent after its run completes.
 */
export async function rePauseAgent(
  ctx: PluginContext,
  agentId: string,
  companyId: string,
): Promise<boolean> {
  try {
    await ctx.agents.pause({ agentId, companyId });
    return true;
  } catch {
    return false;
  }
}

/**
 * Initial enrollment scan: pause all non-exempt, idle agents.
 */
export async function initialEnrollment(
  ctx: PluginContext,
  companyId: string,
): Promise<{ enrolled: string[]; exempt: string[] }> {
  const config = await getConfig(ctx);
  const agentsById = await loadAgentMap(ctx, companyId);
  const managed = await getManagedAgentIds(ctx);
  const enrolled: string[] = [];
  const exempt: string[] = [];

  for (const agent of agentsById.values()) {
    if (isExempt(agent, config)) {
      exempt.push(agent.id);
      managed.delete(agent.id);
      continue;
    }
    if (agent.status === "terminated") continue;

    if (!managed.has(agent.id)) {
      await enrollAgent(ctx, agent, managed);
      enrolled.push(agent.id);
    }
  }

  await setManagedAgentIds(ctx, managed);
  return { enrolled, exempt };
}
