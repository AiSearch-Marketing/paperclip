# Token Usage & Optimization Guide

## How Tokens Are Tracked

### Per-Run Token Tracking
Every heartbeat run records token usage in `usageJson`:
```typescript
{
  inputTokens: number,        // Delta input tokens for this run
  cachedInputTokens: number,  // Delta cached input tokens
  outputTokens: number,       // Delta output tokens
  rawInputTokens: number,     // Raw cumulative from adapter
  rawCachedInputTokens: number,
  rawOutputTokens: number,
  sessionReused: boolean,     // Was an existing session continued?
  freshSession: boolean,      // Was this a brand new session?
  sessionRotated: boolean,    // Was session rotated due to compaction?
  provider: string,           // "anthropic", "openai", etc.
  model: string,              // Specific model used
  costUsd: number,            // USD cost reported by adapter
  billingType: string,        // "metered_api", "subscription_included", etc.
}
```

### Session Delta Calculation
When sessions are reused, Paperclip calculates the **delta** (new tokens only):
- Gets `rawUsage` from the adapter (cumulative session totals)
- Finds previous run with same session ID
- Computes: `delta = current_raw - previous_raw`
- This avoids double-counting tokens across resumed sessions

Location: `heartbeat.ts` → `resolveSessionUsage()`

### Cost Event Storage
Cost events are stored in `costEvents` table with indexes on `(companyId, occurredAt)` and `(companyId, agentId, occurredAt)` for efficient querying.

Monthly spend is **always recalculated** from source events (not incremented), ensuring consistency.

## Token Optimization Levers

### 1. Session Compaction (Most Impactful)

**What it does:** Automatically rotates sessions when token thresholds are exceeded, preventing context windows from growing unbounded.

**Configuration** (per-agent in `runtimeConfig.sessionCompaction`):
```typescript
{
  enabled: boolean,           // Enable session compaction (default: false)
  maxRawInputTokens: number,  // Rotate when raw input tokens exceed this
  maxSessionRuns: number,     // Rotate after N runs in same session
  maxSessionAgeHours: number, // Rotate after N hours
}
```

**Location:** `heartbeat.ts` → `evaluateSessionCompaction()` (line ~943)

**How it works:**
1. Before each run, checks if session exceeds thresholds
2. If exceeded, sets `rotate: true` and generates handoff markdown
3. Previous session context is summarized and injected as `paperclipSessionHandoffMarkdown`
4. New session starts fresh with handoff context

**Recommendation:** Enable for long-running agents. Set `maxRawInputTokens` to ~80% of the model's context window. Set `maxSessionRuns` to 10-20 for agents that do many small tasks.

### 2. Wakeup Coalescing (Prevents Redundant Runs)

**What it does:** When multiple wakeup requests arrive for the same agent+issue while a run is active, they're merged into the running run instead of queuing duplicates.

**Location:** `heartbeat.ts` → `enqueueWakeup()` coalescing logic

**How it works:**
- Same agent assigned to same issue with running run → merge context
- Records as `coalescedCount` on the wakeup request
- Different agent on same issue → deferred until first finishes

**Token savings:** Prevents N identical runs when rapid events fire (e.g., multiple comments on same issue).

### 3. Heartbeat Interval Tuning

**Per-agent configuration** (`runtimeConfig.heartbeat`):
```typescript
{
  enabled: boolean,          // Enable timer heartbeats (default: true)
  intervalSec: number,       // Seconds between auto-wakeups (default: 0 = disabled)
  wakeOnDemand: boolean,     // Allow non-timer wakeups (default: true)
  maxConcurrentRuns: number, // Max parallel runs (1-10, default: 1)
}
```

**Server-level:**
- `HEARTBEAT_SCHEDULER_INTERVAL_MS`: How often scheduler checks (default: 30000ms)
- `HEARTBEAT_SCHEDULER_ENABLED`: Global on/off

**Optimization tips:**
- Set `intervalSec: 0` for agents that should only wake on-demand (no polling)
- Use higher intervals (600-3600s) for monitoring agents
- Keep `maxConcurrentRuns: 1` unless parallelism is genuinely needed
- Disable `wakeOnDemand` for agents that should only run on schedule

### 4. Task Session Reuse

**What it does:** Persists session state between runs for the same task, so agents don't re-read entire context.

**Key:** `agentTaskSessions` table, keyed by `(agentId, adapterType, taskKey)`

**Token savings:** Cached input tokens are significantly cheaper than fresh input tokens with providers like Anthropic.

**When sessions reset:**
- `wakeReason === "issue_assigned"` → fresh session
- `forceFreshSession === true` → fresh session
- `adapterResult.clearSession === true` → clear saved session
- Session compaction triggers → rotate with handoff

### 5. Budget Hard Stops

**What it does:** Automatically pauses agents/companies when spend exceeds budget.

**Configuration** (`budgetPolicies` table):
```typescript
{
  scopeType: "company" | "agent" | "project",
  amount: number,            // Budget in cents
  windowKind: "calendar_month_utc" | "lifetime",
  warnPercent: number,       // Soft warning at N% (default: 80)
  hardStopEnabled: boolean,  // Auto-pause at limit
}
```

**Enforcement flow:**
1. Soft threshold (80%) → logs warning activity
2. Hard threshold (100%) → pauses scope, cancels all queued/running work
3. Requires manual approval to resume (`raise_budget_and_resume` or `dismiss_and_keep_paused`)

### 6. Billing Type Awareness

Different billing types affect actual cost:
- `subscription_included` → $0 (included in plan)
- `metered_api` → Billed at actual usage
- `subscription_overage` → Only overage charged
- `credits` → Deducted from credit balance

The system normalizes billing via `normalizeLedgerBillingType()` in heartbeat.ts.

## Monitoring Token Usage

### API Endpoints
| Endpoint | Purpose |
|----------|---------|
| `GET /companies/:id/costs/summary` | Total spend + budget utilization |
| `GET /companies/:id/costs/by-agent` | Per-agent breakdown with token counts |
| `GET /companies/:id/costs/by-agent-model` | Per-agent + model combination |
| `GET /companies/:id/costs/window-spend` | Rolling 5h/24h/7d spend windows |
| `GET /companies/:id/costs/quota-windows` | External provider rate limits |

### Key Metrics to Watch
- `inputTokens` vs `cachedInputTokens` ratio (higher cache = cheaper)
- `sessionReused: true` runs (reuse = cheaper than fresh)
- `sessionRotated: true` frequency (too frequent = losing context; too rare = bloated sessions)
- Per-agent `spentMonthlyCents` vs `budgetMonthlyCents`

## Architecture Decisions Worth Knowing

1. **Monthly spend is always recalculated from events**, not incrementally tracked. This prevents drift but means queries hit the costEvents table.

2. **Session compaction uses raw adapter totals**, not deltas. This means thresholds apply to the total session size, not per-run usage.

3. **Budget enforcement is synchronous** - checked before run starts (`getInvocationBlock()`) and after cost events are recorded.

4. **Wakeup coalescing only works for same-agent same-issue** combinations. Cross-agent wakeups use deferral instead.

5. **The scheduler tick interval (30s default) is separate from agent heartbeat intervals.** The scheduler runs every 30s and checks if any agent's interval has elapsed.
