# Token Governor Plugin

A Paperclip plugin that makes agents **dormant by default** and only wakes them when their manager or the CEO explicitly delegates work. After the agent finishes its run, the plugin pauses it again. This eliminates wasted token spend from unnecessary timer heartbeats and uncontrolled wakeups.

## The Problem

By default, Paperclip agents can be woken by anyone, and agents with `heartbeat.intervalSec > 0` poll on a timer even when there's nothing to do. Every wakeup is an LLM invocation that costs tokens. In a company with 10 agents polling every 5 minutes, that's **2,880 wakeups per day** — most of which do nothing useful.

## How It Works

The Token Governor uses a **pause/resume gatekeeper pattern** that works entirely within Paperclip's plugin system — no modifications to core code required.

```
Normal Paperclip:
  Timer tick → Agent wakes → Checks for work → Nothing to do → Idles → Repeat
  Issue assigned → Agent wakes → Works → Idles → Timer wakes it again anyway

With Token Governor:
  Agent is PAUSED (dormant)
  Issue assigned by CEO → Plugin checks chain of command → APPROVED
    → Plugin resumes agent → Agent works → Agent finishes → Plugin re-pauses
  Random wakeup attempt → Plugin checks policy → REJECTED → Agent stays dormant
```

### Event-Driven Flow

1. **Startup**: Plugin pauses all non-exempt agents and registers them as "managed"
2. **`issue.updated`**: When an issue is assigned to a managed agent, the plugin checks if the assignor is in the agent's chain of command. If yes, it resumes the agent and invokes it. If no, the wakeup is rejected.
3. **`issue.comment.created`**: When a comment @mentions a managed agent, the plugin resumes and invokes it (if `allowMentionWakes` is enabled)
4. **`agent.run.finished/failed/cancelled`**: Plugin re-pauses the agent
5. **Reconciliation job** (every minute): Catches any agents that should be paused but aren't
6. **Analysis job** (every hour): Generates optimization recommendations
7. **Shutdown**: Resumes all managed agents so they're not stuck paused if the plugin is disabled

### Chain of Command

The plugin uses the `reportsTo` hierarchy to determine who can wake an agent:

```
CEO (exempt — runs on own schedule)
├── CTO (can be woken by CEO)
│   ├── Dev Agent A (can be woken by CTO or CEO)
│   └── Dev Agent B (can be woken by CTO or CEO)
├── CMO (can be woken by CEO)
│   └── Marketing Agent (can be woken by CMO or CEO)
```

The `wakePolicy` setting controls how strict this is:
- **`chain_of_command`** (default): Any manager in the upward chain can wake the agent
- **`direct_manager`**: Only the agent's immediate `reportsTo` can wake it
- **`anyone`**: Any actor can wake (still benefits from dormant-until-assigned behavior)

## Configuration

All settings are configurable via the Paperclip plugin settings UI or API:

| Setting | Default | Description |
|---------|---------|-------------|
| `exemptRoles` | `["ceo"]` | Agent roles that are never paused. The CEO needs its timer heartbeat to initiate work. |
| `exemptAgentIds` | `[]` | Specific agent IDs to exclude from management. |
| `wakePolicy` | `"chain_of_command"` | Who can wake managed agents: `chain_of_command`, `direct_manager`, or `anyone`. |
| `allowMentionWakes` | `true` | Whether @mentions in comments can wake a managed agent, regardless of who posted the comment. |
| `allowDirectUserWakes` | `true` | Whether human users (board operators) can always wake any managed agent. |
| `autoManageNewAgents` | `true` | Whether newly created agents are automatically enrolled under governor management. |
| `maxWakeLogEntries` | `200` | Maximum number of wake log entries to retain in plugin state. |

## Dashboard

The plugin provides two UI surfaces:

### Token Governor Page (`/:companyPrefix/token-governor`)

- **Summary stats**: Managed agent count, active runs, wakeups prevented, estimated savings
- **Agent Management grid**: Every agent with status, governance state, spend, and quick actions (Enroll, Release, Force Wake)
- **Recommendations**: Optimization suggestions with severity levels (no budget set, high burn rate, stale agents, over-provisioned concurrency)
- **Wake Log**: Chronological audit trail of every approved, rejected, and reconciled wake event

### Dashboard Widget

A compact card on the main dashboard showing managed count, active runs, prevented wakeups, and estimated savings.

## Recommendations

The hourly analysis job detects these patterns:

| Pattern | Severity | Description |
|---------|----------|-------------|
| Agent not under governor | Info | Agent could benefit from dormant-until-called management |
| Timer still active | Warning | Managed agent has `intervalSec > 0` (ineffective while paused, wasteful if unpaused) |
| No budget policy | Warning | Agent is spending tokens with no budget limit |
| High burn rate | Critical | Agent has used >80% of budget with >10 days remaining in the month |
| Over-provisioned concurrency | Info | `maxConcurrentRuns > 1` but rarely uses parallel runs |
| Stale agent | Info | No activity in 7+ days but agent isn't paused |

## Architecture

```
plugin-token-governor/
├── src/
│   ├── worker.ts              # Event handlers, jobs, UI bridge
│   ├── gatekeeper.ts          # Pause/resume, chain-of-command validation
│   ├── mention-detector.ts    # @mention parsing from comments
│   ├── spend-tracker.ts       # Savings estimation
│   ├── recommendations.ts     # Efficiency analysis engine
│   ├── wake-log.ts            # Audit trail persistence
│   ├── types.ts               # Shared type definitions
│   ├── constants.ts           # Plugin ID, config defaults, state keys
│   ├── manifest.ts            # Plugin manifest declaration
│   └── index.ts               # Package entry point
├── ui/
│   └── index.tsx              # React components (GovernorPage, GovernorWidget)
├── scripts/
│   └── build-ui.mjs           # esbuild config for UI bundle
├── package.json
└── tsconfig.json
```

### Plugin Capabilities Used

| Capability | Purpose |
|------------|---------|
| `agents.read` | List agents, read `reportsTo` hierarchy |
| `agents.pause` | Pause managed agents |
| `agents.resume` | Resume agents for approved wakeups |
| `agents.invoke` | Trigger agent execution after resume |
| `events.subscribe` | React to issue assignments, comments, run completions |
| `plugin.state.read/write` | Persist managed agent list, wake log, savings, recommendations |
| `jobs.schedule` | Reconciliation (every minute) and analysis (every hour) |
| `costs.read` | Read cost data for analysis |
| `ui.page.register` | Token Governor dashboard page |
| `ui.dashboardWidget.register` | Summary widget on main dashboard |

## Known Limitations

1. **No true wakeup interception**: The plugin can't block wakeups mid-flight. It works by keeping agents paused (which causes the native wakeup system to reject them) and then handling wakeups itself. There's a small window between resume and re-pause where a stray wakeup could get through — mitigated by the reconciliation job.

2. **No config writes**: The plugin cannot modify agent `runtimeConfig` (heartbeat settings, session compaction thresholds). Recommendations for those changes are display-only.

3. **Comment body availability**: The `issue.comment.created` event may not include the full comment body in all cases. The mention detector works best when the event payload includes the `body` field.

4. **Single-company focus**: The plugin iterates companies on startup and during jobs. For deployments with many companies, the reconciliation job may need its frequency adjusted.
