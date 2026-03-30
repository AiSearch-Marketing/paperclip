# Heartbeat Optimization Guide

## Overview

The heartbeat is Paperclip's core execution engine (`server/src/services/heartbeat.ts`, ~3000+ lines). Every agent run flows through it. Optimizing the heartbeat directly reduces token spend and latency.

## The Heartbeat Scheduler

**Location:** `server/src/services/cron.ts` + `heartbeat.ts` → `tickTimers()`

**How it works:**
1. A global scheduler runs every `HEARTBEAT_SCHEDULER_INTERVAL_MS` (default: 30s)
2. On each tick, it queries ALL active agents with `heartbeat.intervalSec > 0`
3. For each agent: if `now - lastHeartbeatAt >= intervalSec * 1000` → enqueue wakeup
4. The baseline is `agent.lastHeartbeatAt` (or `agent.createdAt` if never run)

**Optimization opportunities:**
- Increase `HEARTBEAT_SCHEDULER_INTERVAL_MS` if 30s granularity isn't needed (saves DB queries)
- Most agents should have `intervalSec: 0` (on-demand only)
- Only monitoring/CEO agents typically need timer-based heartbeats

## Session Management (Critical for Token Savings)

### Session Reuse
Sessions persist between runs via `agentTaskSessions` table:
- Keyed by `(agentId, adapterType, taskKey)` where `taskKey` = issue ID
- Reused sessions mean the LLM doesn't re-read the entire conversation
- Cached input tokens are much cheaper than fresh input tokens

### Session Compaction Thresholds
**Location:** `heartbeat.ts` → `evaluateSessionCompaction()` (~line 943)

**Config** (per-agent `runtimeConfig.sessionCompaction`):
```typescript
{
  enabled: true,
  maxRawInputTokens: 150000,   // Rotate at 150k raw input tokens
  maxSessionRuns: 15,           // Rotate after 15 runs in same session
  maxSessionAgeHours: 24,       // Rotate after 24 hours
}
```

**How compaction decides to rotate:**
1. Finds all runs with same `sessionIdAfter` (the persisted session)
2. Checks `rawInputTokens` from the latest run's `usageJson` against `maxRawInputTokens`
3. Checks run count against `maxSessionRuns`
4. Checks session age (oldest run to newest) against `maxSessionAgeHours`
5. If any threshold exceeded → rotate = true

**When rotation happens:**
- `paperclipSessionHandoffMarkdown` is injected into context (summary of previous session)
- `paperclipSessionRotationReason` explains why
- `paperclipPreviousSessionId` preserves reference to old session
- Session params and display ID are cleared → adapter starts fresh

**Tuning recommendations:**
| Agent Pattern | maxRawInputTokens | maxSessionRuns | maxSessionAgeHours |
|---------------|-------------------|----------------|--------------------|
| Long-running tasks | 150k-180k | 20 | 48 |
| Quick fire-and-forget | Disabled | 5 | 4 |
| CEO/monitoring | 100k | 10 | 24 |
| Code review agents | 120k | 8 | 12 |

### Session Reset Triggers
Sessions reset automatically when:
- `wakeReason === "issue_assigned"` → fresh session for new assignment
- `forceFreshSession === true` → explicit request
- `adapterResult.clearSession === true` → adapter requested clear
- Session compaction thresholds exceeded → rotate with handoff

## Wakeup Coalescing (Prevents Redundant Runs)

**Problem:** Rapid events (multiple comments, rapid re-assignments) can trigger many wakeups.

**Solution:** Coalescing merges redundant wakeups into the running run:

```
Agent A working on Issue #1
  → New comment on Issue #1 → wakeup request for Agent A
  → Agent A already running on Issue #1 → COALESCE
  → Context merged into running run, coalescedCount++
  → No new run created
```

**Deferral for cross-agent:**
```
Agent A working on Issue #1
  → Issue #1 reassigned to Agent B → wakeup request for Agent B
  → Agent A still running → DEFER
  → Wakeup saved with status "deferred_issue_execution"
  → When Agent A finishes → releaseIssueExecutionAndPromote()
  → Deferred wakeup promoted to queued → Agent B starts
```

## Concurrent Run Limits

**Config:** `runtimeConfig.heartbeat.maxConcurrentRuns` (1-10, default 1)

**Why default to 1:**
- Each concurrent run is a separate LLM invocation → separate token cost
- Concurrent runs on same issue can cause conflicts
- Most agents work sequentially on tasks

**When to increase:**
- Agent handles independent issues that don't share workspace
- High-throughput agents that need to process a backlog quickly
- Only if budget can absorb the multiplied cost

## Heartbeat Timer Configuration Matrix

| Agent Role | intervalSec | wakeOnDemand | Rationale |
|------------|-------------|--------------|-----------|
| CEO | 300-600 | true | Periodic check-ins + responsive to events |
| CTO/IC agents | 0 | true | Only wake when assigned work |
| Monitoring agent | 1800-3600 | false | Strict schedule, no interrupts |
| Idle/standby agent | 0 | false | Completely dormant, manually triggered only |
| High-priority agent | 0 | true | Instant response to assignments only |

## The Run Lifecycle and Where Tokens Are Spent

```
1. enqueueWakeup()        → 0 tokens (just DB operations)
2. claimQueuedRun()       → 0 tokens (state transition)
3. Workspace resolution   → 0 tokens (git operations)
4. Session compaction     → 0 tokens (threshold check)
5. adapter.execute()      → ALL TOKENS SPENT HERE
6. Usage recording        → 0 tokens (DB operations)
7. Cost event creation    → 0 tokens (DB operations)
8. Status finalization    → 0 tokens (DB operations)
```

**Step 5 is where optimization matters.** Everything else is DB/filesystem overhead.

## Reducing Token Usage in adapter.execute()

### What the adapter receives:
- Agent instructions (from managed instruction bundles)
- Context snapshot (issue details, workspace hints, runtime services)
- Session state (reused or fresh)
- Handoff markdown (if session was rotated)

### Optimization strategies:

1. **Keep agent instructions concise** - They're injected on every run
2. **Use session reuse aggressively** - Cached tokens are cheaper
3. **Set appropriate compaction thresholds** - Don't rotate too early (loses context) or too late (bloated sessions)
4. **Minimize context snapshot size** - Only include relevant issue/workspace data
5. **Use `taskKey` consistently** - Ensures session reuse works correctly

## Monitoring and Debugging

### Check agent heartbeat status:
```
GET /api/companies/:companyId/agents/:agentId/heartbeat-status
```
Returns: `enabled`, `intervalSec`, `wakeOnDemand`, `schedulerActive`, policy details.

### Check run usage:
```
GET /api/companies/:companyId/agents/:agentId/runs
```
Each run includes `usageJson` with full token breakdown.

### Identify wasteful patterns:
- High `freshSession: true` ratio → sessions not being reused
- High `sessionRotated: true` frequency → compaction thresholds too low
- Many coalesced wakeups → consider debouncing at source
- `billingType: "metered_api"` with high costs → check if subscription tier available

### Rolling spend windows:
```
GET /api/companies/:companyId/costs/window-spend
```
Returns 5-hour, 24-hour, and 7-day rolling spend. Useful for spotting spikes.

## Server-Level Tuning

| Setting | Default | Recommendation |
|---------|---------|----------------|
| `HEARTBEAT_SCHEDULER_INTERVAL_MS` | 30000 | 60000 if <10 agents, 30000 for larger |
| `HEARTBEAT_SCHEDULER_ENABLED` | true | false on read-only replicas |

## Common Pitfalls

1. **Setting intervalSec too low** → Agent wakes constantly, burns tokens checking for nothing
2. **Not enabling session compaction** → Sessions grow unbounded, context window fills up, costs spike
3. **maxConcurrentRuns > 1 without need** → Multiplied token costs for no benefit
4. **Forgetting budget hard stops** → Runaway agent can burn unlimited tokens
5. **Not monitoring cachedInputTokens ratio** → Missing optimization opportunities
6. **Rotating sessions too aggressively** → Agent loses context, spends tokens re-reading
