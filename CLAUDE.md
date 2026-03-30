# Paperclip Codebase Context

## What Is Paperclip?

Paperclip is a Node.js/React control plane for orchestrating autonomous AI agent companies. It manages agent registry, task assignment, budgets, goal hierarchy, and governance. One deployment can run multiple isolated companies with complete data separation.

**Architecture layers:**
- **Control Plane** (`server/`): Express API + PostgreSQL, manages agents, tasks, budgets, goals, governance
- **Execution Layer**: External adapters (Claude Code, Codex, Cursor, Gemini, OpenCode, Pi, HTTP) that agents run through
- **UI** (`ui/`): React frontend with real-time updates via WebSocket

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `server/src/services/` | Core business logic (heartbeat, costs, budgets, agents, etc.) |
| `server/src/routes/` | Express API routes |
| `server/src/adapters/` | LLM adapter implementations |
| `server/src/services/heartbeat.ts` | **Central execution engine** - agent wakeup, run lifecycle, session management |
| `server/src/services/costs.ts` | Token cost tracking and monthly spend |
| `server/src/services/budgets.ts` | Budget policies and enforcement |
| `server/src/services/agents.ts` | Agent CRUD, state management, config revisions |
| `server/src/services/workspace-runtime.ts` | Runtime service lifecycle (start/stop/reuse) |
| `server/src/services/execution-workspaces.ts` | Git worktree isolation per task |
| `ui/` | React frontend |
| `packages/` | Shared packages (db schema, shared types, adapter-utils) |
| `skills/` | Agent skill definitions |

## Critical Files for Token/Cost Optimization

1. **`server/src/services/heartbeat.ts`** - The 3000+ line heartbeat engine. Controls:
   - Session compaction (token threshold rotation)
   - Wakeup coalescing (prevents redundant runs)
   - Concurrent run limits
   - Usage delta calculation

2. **`server/src/services/costs.ts`** - Cost event recording, monthly spend recalculation

3. **`server/src/services/budgets.ts`** - Budget policies with soft/hard thresholds, auto-pause on overspend

4. **`server/src/services/quota-windows.ts`** - External provider rate limit tracking

5. **`server/src/services/finance.ts`** - Separate ledger for financial transactions (debit/credit)

6. **`server/src/services/cron.ts`** - Scheduler for timer-based heartbeats

7. **`packages/adapter-utils/`** - Session compaction policy parsing and threshold checks

## Configuration

Config loaded from (precedence order):
1. Environment variables
2. Config file (`~/.paperclip/instances/default/config.json`)
3. `.env` files

Key env vars: `HEARTBEAT_SCHEDULER_ENABLED`, `HEARTBEAT_SCHEDULER_INTERVAL_MS`, `DATABASE_URL`, `PAPERCLIP_DEPLOYMENT_MODE`

## Running

```bash
pnpm install
pnpm dev        # Development server
pnpm test       # Run tests
pnpm build      # Production build
```
