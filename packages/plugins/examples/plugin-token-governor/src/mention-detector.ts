import type { AgentRecord } from "./types.js";

/**
 * Regex for @mention syntax: \B@([^\s@,!?.]+)
 * Matches tokens like @AgentName in comment text.
 * Mirrors the pattern used in server/src/services/issues.ts.
 */
const AT_MENTION_RE = /\B@([^\s@,!?.]+)/g;

/**
 * Regex for rich mention links: [text](agent://agent-id?...)
 * Mirrors the pattern from packages/shared/src/project-mentions.ts.
 */
const RICH_MENTION_RE = /\[(?:[^\]]*)\]\(agent:\/\/([a-f0-9-]+)[^)]*\)/gi;

/**
 * Extract mentioned agent IDs from a comment body.
 * Handles both @AgentName syntax and rich [text](agent://id) links.
 */
export function extractMentionedAgentIds(
  commentBody: string,
  agentsByName: Map<string, AgentRecord>,
): Set<string> {
  const mentioned = new Set<string>();

  // Extract @mentions and resolve by name (case-insensitive)
  for (const match of commentBody.matchAll(AT_MENTION_RE)) {
    const token = match[1];
    if (!token) continue;
    const lower = token.toLowerCase();
    for (const [name, agent] of agentsByName) {
      if (name.toLowerCase() === lower) {
        mentioned.add(agent.id);
        break;
      }
    }
  }

  // Extract rich mention links and resolve by ID directly
  for (const match of commentBody.matchAll(RICH_MENTION_RE)) {
    const agentId = match[1];
    if (agentId) {
      mentioned.add(agentId);
    }
  }

  return mentioned;
}

/**
 * Build a name→agent lookup map for mention resolution.
 */
export function buildAgentNameMap(
  agentsById: Map<string, AgentRecord>,
): Map<string, AgentRecord> {
  const byName = new Map<string, AgentRecord>();
  for (const agent of agentsById.values()) {
    byName.set(agent.name, agent);
  }
  return byName;
}
