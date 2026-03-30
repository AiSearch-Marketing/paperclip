import { useState, type CSSProperties } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  usePluginStream,
  type PluginPageProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { STREAM_CHANNELS } from "../constants.js";
import type { GovernorConfig } from "../constants.js";
import type { WakeLogEntry, Recommendation, SavingsData, AgentMetrics } from "../types.js";

// ──────────────────────────────────────────────────────────
// Types for data from worker bridge
// ──────────────────────────────────────────────────────────

type AgentSummary = {
  id: string;
  name: string;
  role: string | null;
  status: string;
  managed: boolean;
  exempt: boolean;
  activeRun: boolean;
  lastHeartbeatAt: string | null;
  spentMonthlyCents: number | null;
  budgetMonthlyCents: number | null;
};

type OverviewData = {
  config: GovernorConfig;
  agents: AgentSummary[];
  managedCount: number;
  exemptCount: number;
  activeRunCount: number;
  savings: SavingsData;
  wakeLog: WakeLogEntry[];
  recommendations: Recommendation[];
  metrics: AgentMetrics[];
};

// ──────────────────────────────────────────────────────────
// Styles
// ──────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  display: "grid",
  gap: "16px",
  maxWidth: "1200px",
  padding: "20px",
};

const cardStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "12px",
  padding: "16px",
  background: "var(--card, transparent)",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
  gap: "12px",
};

const statCardStyle: CSSProperties = {
  ...cardStyle,
  textAlign: "center" as const,
};

const badgeStyle = (color: string): CSSProperties => ({
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "9999px",
  fontSize: "11px",
  fontWeight: 600,
  background: color,
  color: "#fff",
});

const btnStyle: CSSProperties = {
  padding: "4px 10px",
  borderRadius: "6px",
  border: "1px solid var(--border)",
  background: "var(--card, transparent)",
  cursor: "pointer",
  fontSize: "12px",
};

const btnPrimaryStyle: CSSProperties = {
  ...btnStyle,
  background: "var(--primary, #2563eb)",
  color: "#fff",
  borderColor: "var(--primary, #2563eb)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: "13px",
};

const thStyle: CSSProperties = {
  textAlign: "left" as const,
  padding: "6px 8px",
  borderBottom: "1px solid var(--border)",
  fontWeight: 600,
  fontSize: "11px",
  textTransform: "uppercase" as const,
  opacity: 0.7,
};

const tdStyle: CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
};

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function formatCents(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) +
      " " + d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "paused": return "#6b7280";
    case "idle": return "#3b82f6";
    case "running": return "#22c55e";
    case "error": return "#ef4444";
    default: return "#9ca3af";
  }
}

function actionColor(action: WakeLogEntry["action"]): string {
  switch (action) {
    case "approved": return "#22c55e";
    case "rejected": return "#ef4444";
    case "completed": return "#3b82f6";
    case "auto_paused": return "#6b7280";
    case "auto_resumed": return "#f59e0b";
    case "reconciled": return "#8b5cf6";
    default: return "#9ca3af";
  }
}

function severityColor(severity: Recommendation["severity"]): string {
  switch (severity) {
    case "critical": return "#ef4444";
    case "warning": return "#f59e0b";
    case "info": return "#3b82f6";
    default: return "#9ca3af";
  }
}

// ──────────────────────────────────────────────────────────
// Summary Stats
// ──────────────────────────────────────────────────────────

function SummaryStats({ data }: { data: OverviewData }) {
  return (
    <div style={gridStyle}>
      <div style={statCardStyle}>
        <div style={{ fontSize: "28px", fontWeight: 700 }}>{data.managedCount}</div>
        <div style={{ fontSize: "12px", opacity: 0.7 }}>Managed Agents</div>
      </div>
      <div style={statCardStyle}>
        <div style={{ fontSize: "28px", fontWeight: 700 }}>{data.activeRunCount}</div>
        <div style={{ fontSize: "12px", opacity: 0.7 }}>Active Runs</div>
      </div>
      <div style={statCardStyle}>
        <div style={{ fontSize: "28px", fontWeight: 700 }}>{data.savings.preventedWakeups}</div>
        <div style={{ fontSize: "12px", opacity: 0.7 }}>Wakeups Prevented</div>
      </div>
      <div style={statCardStyle}>
        <div style={{ fontSize: "28px", fontWeight: 700, color: "#22c55e" }}>
          {formatCents(data.savings.estimatedSavingsCents)}
        </div>
        <div style={{ fontSize: "12px", opacity: 0.7 }}>Estimated Savings</div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Managed Agent Grid
// ──────────────────────────────────────────────────────────

function ManagedAgentGrid({
  agents,
  onEnroll,
  onUnenroll,
  onForceWake,
}: {
  agents: AgentSummary[];
  onEnroll: (id: string) => void;
  onUnenroll: (id: string) => void;
  onForceWake: (id: string) => void;
}) {
  return (
    <div style={cardStyle}>
      <h3 style={{ margin: "0 0 12px 0", fontSize: "14px", fontWeight: 600 }}>
        Agent Management
      </h3>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Agent</th>
            <th style={thStyle}>Role</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Governed</th>
            <th style={thStyle}>Last Active</th>
            <th style={thStyle}>Spend</th>
            <th style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.id}>
              <td style={tdStyle}>
                <span style={{ fontWeight: 500 }}>{agent.name}</span>
              </td>
              <td style={tdStyle}>
                <span style={{ opacity: 0.7, fontSize: "12px" }}>{agent.role ?? "—"}</span>
              </td>
              <td style={tdStyle}>
                <span style={badgeStyle(statusColor(agent.status))}>
                  {agent.activeRun ? "running" : agent.status}
                </span>
              </td>
              <td style={tdStyle}>
                {agent.exempt ? (
                  <span style={{ opacity: 0.5, fontSize: "12px" }}>exempt</span>
                ) : agent.managed ? (
                  <span style={badgeStyle("#22c55e")}>managed</span>
                ) : (
                  <span style={badgeStyle("#9ca3af")}>unmanaged</span>
                )}
              </td>
              <td style={tdStyle}>
                <span style={{ fontSize: "12px" }}>{formatTime(agent.lastHeartbeatAt)}</span>
              </td>
              <td style={tdStyle}>
                <span style={{ fontSize: "12px" }}>
                  {formatCents(agent.spentMonthlyCents)}
                  {agent.budgetMonthlyCents ? (
                    <span style={{ opacity: 0.5 }}> / {formatCents(agent.budgetMonthlyCents)}</span>
                  ) : null}
                </span>
              </td>
              <td style={tdStyle}>
                {agent.exempt ? null : agent.managed ? (
                  <span style={{ display: "flex", gap: "4px" }}>
                    <button style={btnStyle} onClick={() => onUnenroll(agent.id)}>
                      Release
                    </button>
                    <button style={btnStyle} onClick={() => onForceWake(agent.id)}>
                      Wake
                    </button>
                  </span>
                ) : (
                  <button style={btnPrimaryStyle} onClick={() => onEnroll(agent.id)}>
                    Enroll
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Wake Log
// ──────────────────────────────────────────────────────────

function WakeLog({ entries }: { entries: WakeLogEntry[] }) {
  if (entries.length === 0) {
    return (
      <div style={cardStyle}>
        <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: 600 }}>Wake Log</h3>
        <p style={{ opacity: 0.5, fontSize: "13px" }}>No activity yet.</p>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <h3 style={{ margin: "0 0 12px 0", fontSize: "14px", fontWeight: 600 }}>Wake Log</h3>
      <div style={{ maxHeight: "360px", overflowY: "auto" }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Time</th>
              <th style={thStyle}>Agent</th>
              <th style={thStyle}>Action</th>
              <th style={thStyle}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td style={tdStyle}>
                  <span style={{ fontSize: "12px" }}>{formatTime(entry.timestamp)}</span>
                </td>
                <td style={tdStyle}>
                  <span style={{ fontWeight: 500, fontSize: "13px" }}>{entry.agentName}</span>
                </td>
                <td style={tdStyle}>
                  <span style={badgeStyle(actionColor(entry.action))}>
                    {entry.action}
                  </span>
                </td>
                <td style={tdStyle}>
                  <span style={{ fontSize: "12px", opacity: 0.8 }}>{entry.reason}</span>
                  {entry.durationMs != null ? (
                    <span style={{ fontSize: "11px", opacity: 0.5, marginLeft: "6px" }}>
                      ({(entry.durationMs / 1000).toFixed(1)}s)
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Recommendations Panel
// ──────────────────────────────────────────────────────────

function RecommendationsPanel({
  recommendations,
  onDismiss,
}: {
  recommendations: Recommendation[];
  onDismiss: (id: string) => void;
}) {
  if (recommendations.length === 0) {
    return (
      <div style={cardStyle}>
        <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: 600 }}>
          Recommendations
        </h3>
        <p style={{ opacity: 0.5, fontSize: "13px" }}>No recommendations. Looking good!</p>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <h3 style={{ margin: "0 0 12px 0", fontSize: "14px", fontWeight: 600 }}>
        Recommendations ({recommendations.length})
      </h3>
      <div style={{ display: "grid", gap: "8px" }}>
        {recommendations.map((rec) => (
          <div
            key={rec.id}
            style={{
              border: `1px solid color-mix(in srgb, ${severityColor(rec.severity)} 40%, transparent)`,
              borderRadius: "8px",
              padding: "10px 12px",
              display: "flex",
              alignItems: "flex-start",
              gap: "10px",
            }}
          >
            <span style={badgeStyle(severityColor(rec.severity))}>{rec.severity}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500, fontSize: "13px" }}>{rec.title}</div>
              <div style={{ fontSize: "12px", opacity: 0.7, marginTop: "2px" }}>
                {rec.description}
              </div>
              {rec.estimatedSavingsCents > 0 ? (
                <div style={{ fontSize: "11px", color: "#22c55e", marginTop: "4px" }}>
                  Estimated savings: {formatCents(rec.estimatedSavingsCents)}/day
                </div>
              ) : null}
            </div>
            <button style={btnStyle} onClick={() => onDismiss(rec.id)}>
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Governor Page (main dashboard)
// ──────────────────────────────────────────────────────────

export function GovernorPage({ context }: PluginPageProps) {
  const hostCtx = useHostContext();
  const companyId = hostCtx?.companyId ?? "";

  const { data, loading, error, refetch } = usePluginData<OverviewData>("overview", {
    companyId,
  });

  const enrollAction = usePluginAction("enroll-agent");
  const unenrollAction = usePluginAction("unenroll-agent");
  const forceWakeAction = usePluginAction("force-wake");
  const dismissAction = usePluginAction("dismiss-recommendation");
  const enrollAllAction = usePluginAction("run-enrollment");

  // Listen for live wake-log events
  const streamEvent = usePluginStream(STREAM_CHANNELS.wakeLog);

  const handleEnroll = async (agentId: string) => {
    await enrollAction.execute({ agentId, companyId });
    refetch();
  };

  const handleUnenroll = async (agentId: string) => {
    await unenrollAction.execute({ agentId, companyId });
    refetch();
  };

  const handleForceWake = async (agentId: string) => {
    await forceWakeAction.execute({ agentId, companyId });
    refetch();
  };

  const handleDismiss = async (recommendationId: string) => {
    await dismissAction.execute({ recommendationId });
    refetch();
  };

  const handleEnrollAll = async () => {
    await enrollAllAction.execute({ companyId });
    refetch();
  };

  if (loading) {
    return (
      <div style={pageStyle}>
        <p style={{ opacity: 0.5 }}>Loading Token Governor...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <p style={{ color: "#ef4444" }}>Failed to load governor data.</p>
          <button style={btnStyle} onClick={refetch}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>Token Governor</h2>
        <div style={{ display: "flex", gap: "8px" }}>
          <button style={btnStyle} onClick={refetch}>Refresh</button>
          <button style={btnPrimaryStyle} onClick={handleEnrollAll}>
            Enroll All Agents
          </button>
        </div>
      </div>

      <SummaryStats data={data} />

      <ManagedAgentGrid
        agents={data.agents}
        onEnroll={handleEnroll}
        onUnenroll={handleUnenroll}
        onForceWake={handleForceWake}
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
        <RecommendationsPanel
          recommendations={data.recommendations}
          onDismiss={handleDismiss}
        />
        <WakeLog entries={data.wakeLog} />
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Dashboard Widget
// ──────────────────────────────────────────────────────────

export function GovernorWidget({ context }: PluginWidgetProps) {
  const hostCtx = useHostContext();
  const companyId = hostCtx?.companyId ?? "";

  const { data, loading } = usePluginData<OverviewData>("overview", { companyId });

  if (loading || !data) {
    return (
      <div style={{ padding: "12px", fontSize: "13px", opacity: 0.5 }}>
        Token Governor loading...
      </div>
    );
  }

  return (
    <div style={{ padding: "12px" }}>
      <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "8px" }}>
        Token Governor
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", fontSize: "12px" }}>
        <div>
          <span style={{ opacity: 0.6 }}>Managed: </span>
          <span style={{ fontWeight: 600 }}>{data.managedCount}</span>
        </div>
        <div>
          <span style={{ opacity: 0.6 }}>Active: </span>
          <span style={{ fontWeight: 600 }}>{data.activeRunCount}</span>
        </div>
        <div>
          <span style={{ opacity: 0.6 }}>Prevented: </span>
          <span style={{ fontWeight: 600 }}>{data.savings.preventedWakeups}</span>
        </div>
        <div>
          <span style={{ opacity: 0.6 }}>Saved: </span>
          <span style={{ fontWeight: 600, color: "#22c55e" }}>
            {formatCents(data.savings.estimatedSavingsCents)}
          </span>
        </div>
      </div>
      {data.recommendations.length > 0 ? (
        <div style={{
          marginTop: "8px",
          padding: "6px 8px",
          borderRadius: "6px",
          background: "color-mix(in srgb, #f59e0b 15%, transparent)",
          fontSize: "12px",
        }}>
          {data.recommendations.length} recommendation{data.recommendations.length > 1 ? "s" : ""} pending
        </div>
      ) : null}
    </div>
  );
}
