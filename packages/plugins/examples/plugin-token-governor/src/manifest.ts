import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  EXPORT_NAMES,
  JOB_KEYS,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Token Governor",
  description:
    "Dormant-until-called agent gatekeeper. Keeps agents paused until their manager " +
    "or the CEO delegates work, then re-pauses after completion. Tracks token spend, " +
    "prevents wasted heartbeats, and provides optimization recommendations.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities: [
    // Read access for analysis
    "companies.read",
    "projects.read",
    "issues.read",
    "agents.read",
    "costs.read",
    // Agent control
    "agents.pause",
    "agents.resume",
    "agents.invoke",
    // State persistence
    "plugin.state.read",
    "plugin.state.write",
    // React to domain events
    "events.subscribe",
    "events.emit",
    // Scheduled reconciliation and analysis
    "jobs.schedule",
    // Activity logging
    "activity.log.write",
    // Dashboard UI
    "ui.page.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      exemptRoles: {
        type: "array",
        title: "Exempt Roles",
        description: "Agent roles that are never paused (e.g. CEO).",
        items: { type: "string" },
        default: DEFAULT_CONFIG.exemptRoles,
      },
      exemptAgentIds: {
        type: "array",
        title: "Exempt Agent IDs",
        description: "Specific agents that are never managed.",
        items: { type: "string" },
        default: DEFAULT_CONFIG.exemptAgentIds,
      },
      wakePolicy: {
        type: "string",
        title: "Wake Policy",
        description: "Who is allowed to wake managed agents via task assignment.",
        enum: ["chain_of_command", "direct_manager", "anyone"],
        default: DEFAULT_CONFIG.wakePolicy,
      },
      allowMentionWakes: {
        type: "boolean",
        title: "Allow @mention Wakes",
        description: "Whether @mentions from any agent can wake a managed agent.",
        default: DEFAULT_CONFIG.allowMentionWakes,
      },
      allowDirectUserWakes: {
        type: "boolean",
        title: "Allow Direct User Wakes",
        description: "Whether human users can always wake any managed agent.",
        default: DEFAULT_CONFIG.allowDirectUserWakes,
      },
      autoManageNewAgents: {
        type: "boolean",
        title: "Auto-Manage New Agents",
        description: "Automatically enroll newly created agents under governor management.",
        default: DEFAULT_CONFIG.autoManageNewAgents,
      },
      maxWakeLogEntries: {
        type: "number",
        title: "Max Wake Log Entries",
        description: "Maximum number of wake log entries to retain.",
        default: DEFAULT_CONFIG.maxWakeLogEntries,
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEYS.reconcile,
      displayName: "Reconcile Managed Agents",
      description:
        "Safety-net scan: re-pauses agents that should be dormant but are idle, " +
        "detects orphaned states, and ensures governor consistency.",
      schedule: "* * * * *",
    },
    {
      jobKey: JOB_KEYS.analyze,
      displayName: "Analyze Token Efficiency",
      description:
        "Hourly analysis of agent efficiency metrics, spend projections, " +
        "and optimization recommendations.",
      schedule: "0 * * * *",
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Token Governor",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Token Governor",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
    ],
  },
};

export default manifest;
