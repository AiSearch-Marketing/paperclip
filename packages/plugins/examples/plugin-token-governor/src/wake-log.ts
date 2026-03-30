import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS } from "./constants.js";
import type { GovernorConfig } from "./constants.js";
import type { WakeLogEntry } from "./types.js";

export async function getWakeLog(ctx: PluginContext): Promise<WakeLogEntry[]> {
  const stored = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.wakeLog,
  });
  if (Array.isArray(stored)) return stored as WakeLogEntry[];
  return [];
}

export async function appendWakeLog(
  ctx: PluginContext,
  entry: Omit<WakeLogEntry, "id" | "timestamp">,
  config: GovernorConfig,
): Promise<WakeLogEntry> {
  const log = await getWakeLog(ctx);
  const full: WakeLogEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  log.unshift(full);
  // Trim to max entries
  if (log.length > config.maxWakeLogEntries) {
    log.length = config.maxWakeLogEntries;
  }
  await ctx.state.set(
    { scopeKind: "instance", stateKey: STATE_KEYS.wakeLog },
    log,
  );
  return full;
}
