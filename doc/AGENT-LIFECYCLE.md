# Agent Lifecycle & Shutdown Guide

## Agent States

```
                    ┌─────────────┐
                    │   created   │
                    └──────┬──────┘
                           │ (activate or auto)
                    ┌──────▼──────┐
              ┌────►│    idle     │◄───────┐
              │     └──────┬──────┘        │
              │            │ (wakeup)      │ (run succeeded)
              │     ┌──────▼──────┐        │
              │     │   running   ├────────┘
              │     └──────┬──────┘
              │            │ (run failed)
              │     ┌──────▼──────┐
              │     │    error    │
              │     └──────┬──────┘
              │            │ (next run succeeds)
              │            └───────────────┘
              │
     ┌────────┴────────┐
     │     paused      │  ← budget, manual, or system
     │  (pauseReason)  │
     └────────┬────────┘
              │ (resume)
              └──► idle

     ┌─────────────────┐
     │   terminated    │  ← permanent, no recovery
     └─────────────────┘
```

**Key fields:**
- `status`: idle | running | paused | error | terminated | pending_approval
- `pauseReason`: "manual" | "budget" | "system" | null
- `lastHeartbeatAt`: Timestamp of last completed run

## How Agents Wake Up

### Trigger Sources
| Source | Description | Example |
|--------|-------------|---------|
| `timer` | Scheduled interval elapsed | Agent checks in every 5 minutes |
| `assignment` | Issue assigned to agent | CEO delegates task to CTO |
| `on_demand` | Manual API call or UI trigger | Human clicks "wake" button |
| `automation` | System event (recovery, promotion) | Deferred wakeup promoted after lock release |

### The Wakeup Flow
```
Trigger arrives
  → enqueueWakeup()
    → Validate: agent exists, not paused/terminated
    → Check budget: getInvocationBlock()
    → Check policy: enabled? wakeOnDemand?
    → Check issue execution lock:
       ├─ No lock → create queued run
       ├─ Same agent running → coalesce (merge context)
       └─ Different agent running → defer (queue for later)
    → Insert wakeupRequest + heartbeatRun (status: "queued")
  → claimQueuedRun()
    → Transition queued → running
    → Check maxConcurrentRuns limit
  → executeRun()
    → Resolve workspace (git worktree, project dir, or agent home)
    → Build runtime config (secrets, env, services)
    → Evaluate session compaction
    → Call adapter.execute()
    → Collect output, costs, usage
  → Finalize
    → Record cost event
    → Persist/clear session
    → Release issue execution lock
    → Promote deferred wakeups
    → Update agent status (idle/error)
```

## How to Close Down Idle Agents

### 1. Disable Timer Heartbeats
Set `runtimeConfig.heartbeat.enabled: false` or `intervalSec: 0`:
```
PATCH /api/agents/:id
{
  "runtimeConfig": {
    "heartbeat": { "enabled": false, "intervalSec": 0 }
  }
}
```
This stops the agent from waking itself. It can still be woken on-demand.

### 2. Disable On-Demand Wakeups Too
```
PATCH /api/agents/:id
{
  "runtimeConfig": {
    "heartbeat": {
      "enabled": false,
      "intervalSec": 0,
      "wakeOnDemand": false
    }
  }
}
```
Now the agent will reject ALL wakeup sources.

### 3. Pause the Agent
```
POST /api/agents/:id/pause
{ "reason": "manual" }
```
- Sets `status: "paused"`, `pauseReason: "manual"`
- All queued wakeups are rejected
- Running runs continue to completion but no new ones start
- Resume with `POST /api/agents/:id/resume`

### 4. Budget-Based Auto-Pause
Set a budget with hard stop:
```
POST /api/companies/:companyId/budgets/policies
{
  "scopeType": "agent",
  "scopeId": "<agentId>",
  "amount": 500,
  "windowKind": "calendar_month_utc",
  "hardStopEnabled": true,
  "warnPercent": 80
}
```
When the agent's monthly spend hits the limit, it's automatically paused and all queued work is cancelled.

### 5. Terminate (Permanent)
```
POST /api/agents/:id/terminate
```
- Irreversible. Agent cannot be resumed.
- Use for agents that are no longer needed.

## Runtime Services & Idle Cleanup

### Service Lifecycle
Services (dev servers, databases, etc.) attached to workspaces have their own lifecycle:

```
Start → Register → Lease (per run) → Release → Idle Timer → Stop
```

### Stop Policies
| Policy | Behavior |
|--------|----------|
| `on_run_finish` | Stop when the run completes (default for ephemeral) |
| `idle_timeout` | Stop after N seconds of no active leases (default: 1800s/30min) |
| `manual` | Only stop on explicit request |

### Service Scopes (for reuse)
| Scope | Shared across |
|-------|---------------|
| `run` | Single run only (ephemeral) |
| `execution_workspace` | All runs in same workspace session |
| `project_workspace` | All runs in same project |
| `agent` | All runs by same agent |

### Idle Detection Flow
1. Run finishes → `releaseRuntimeServicesForRun()`
2. Service lease count drops to 0
3. `scheduleIdleStop()` sets a `setTimeout` for `idleSeconds` (default 1800)
4. If service is reused before timeout → timer cleared, keeps running
5. If timeout fires → `stopRuntimeService()` → SIGTERM then SIGKILL

## Orphaned Process Recovery

The heartbeat service includes `reapOrphanedRuns()`:
- Runs periodically (every 30s at startup, then checks 5-minute threshold)
- Finds runs stuck in "running" status
- Checks if PID is still alive via `kill(pid, 0)`
- If PID dead → marks as "process_lost", queues ONE automatic retry
- If PID alive but no in-memory handle → marks warning "process_detached"
- `processLossRetryCount` prevents infinite retry loops

## Concurrent Run Management

- `maxConcurrentRuns`: 1-10 (default 1)
- Serialized via `withAgentStartLock()` per agent
- `startNextQueuedRunForAgent()` called on run completion to process queue
- Agent stays "running" until ALL concurrent runs finish

## Issue Execution Locking

Issues have an `executionRunId` that ensures only one agent works an issue at a time:
- **Coalescing:** Same agent + same issue + active run → merge context into running run
- **Deferring:** Different agent + same issue + active run → queue with `status: "deferred_issue_execution"`
- **Promotion:** When run finishes → `releaseIssueExecutionAndPromote()` → pop deferred, create new queued run

## Best Practices for Efficient Agent Management

1. **Set `intervalSec: 0`** for agents that should only respond to assignments (most agents)
2. **Use `maxConcurrentRuns: 1`** unless the agent genuinely needs parallelism
3. **Enable session compaction** with `maxRawInputTokens` set to ~80% of context window
4. **Set budgets with `hardStopEnabled: true`** to prevent runaway spending
5. **Use `idle_timeout` stop policy** for runtime services to auto-cleanup
6. **Pause agents** when they're not needed rather than terminating (reversible)
7. **Monitor `lastHeartbeatAt`** to identify agents that haven't run in a long time
8. **Use `wakeOnDemand: false`** for strict-schedule agents to prevent unexpected wakeups
