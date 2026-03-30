# Installing the Token Governor Plugin

## Prerequisites

- A running Paperclip instance (v0.1.0+)
- Node.js 20+ and pnpm installed
- Board-level access (plugin management requires admin privileges)

## Option 1: Install from the Paperclip Monorepo (Development)

If you're running Paperclip from the source monorepo, the plugin is already in the `packages/plugins/examples/` directory.

### Step 1: Build the plugin

```bash
cd packages/plugins/examples/plugin-token-governor
pnpm install
pnpm build
```

This compiles the TypeScript source and bundles the React UI:
- `dist/manifest.js` — Plugin manifest
- `dist/worker.js` — Worker process entry point
- `dist/ui/index.js` — Bundled React components

### Step 2: Install via the Paperclip API

```bash
# Install from local path
curl -X POST http://localhost:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{
    "source": "local",
    "path": "./packages/plugins/examples/plugin-token-governor"
  }'
```

Or install via the Paperclip UI:
1. Navigate to **Instance Settings** > **Plugins**
2. Click **Install Plugin**
3. Select **Local Path** and enter the path to the plugin directory
4. Click **Install**

### Step 3: Verify the plugin is loaded

```bash
curl http://localhost:3100/api/plugins | jq '.[] | select(.id == "paperclip-token-governor")'
```

The plugin should show `status: "ready"`.

## Option 2: Install as a Standalone Package

If you want to use the plugin with a Paperclip instance that isn't running from the monorepo:

### Step 1: Copy the plugin directory

```bash
cp -r packages/plugins/examples/plugin-token-governor /path/to/your/plugins/
cd /path/to/your/plugins/plugin-token-governor
```

### Step 2: Install dependencies and build

```bash
# If the plugin-sdk isn't available as a workspace dependency,
# you'll need to install the published version:
npm install @paperclipai/plugin-sdk
npm install

# Build
npx tsc
node scripts/build-ui.mjs
```

### Step 3: Install in Paperclip

```bash
curl -X POST http://localhost:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{
    "source": "local",
    "path": "/path/to/your/plugins/plugin-token-governor"
  }'
```

## Post-Installation Setup

### 1. Configure the plugin

Navigate to **Instance Settings** > **Plugins** > **Token Governor** > **Settings**, or use the API:

```bash
curl -X POST http://localhost:3100/api/plugins/paperclip-token-governor/config \
  -H "Content-Type: application/json" \
  -d '{
    "exemptRoles": ["ceo"],
    "wakePolicy": "chain_of_command",
    "allowMentionWakes": true,
    "allowDirectUserWakes": true,
    "autoManageNewAgents": true
  }'
```

### 2. Run initial enrollment

The plugin automatically enrolls agents on startup, but you can trigger it manually:

1. Open the Token Governor page: `/:companyPrefix/token-governor`
2. Click **Enroll All Agents**

Or use the UI bridge:

```bash
curl -X POST http://localhost:3100/api/plugins/paperclip-token-governor/bridge/action \
  -H "Content-Type: application/json" \
  -d '{
    "actionKey": "run-enrollment",
    "params": { "companyId": "<your-company-id>" }
  }'
```

### 3. Verify agents are managed

After enrollment, non-exempt agents should show as `status: "paused"`:

```bash
# List agents and check status
curl http://localhost:3100/api/companies/<company-id>/agents | jq '.[] | {name, status, role}'
```

Expected output:
```json
{ "name": "CEO", "status": "idle", "role": "ceo" }
{ "name": "CTO", "status": "paused", "role": "general" }
{ "name": "Dev Agent", "status": "paused", "role": "general" }
```

### 4. Test the wake flow

Assign an issue to a managed agent from the CEO:

```bash
# Create an issue assigned to a managed agent
curl -X POST http://localhost:3100/api/companies/<company-id>/issues \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test task for Token Governor",
    "assigneeAgentId": "<managed-agent-id>",
    "status": "todo"
  }'
```

Watch the Token Governor page — you should see:
1. A wake log entry: "Assignment approved (chain_of_command)"
2. The agent's status change to "running"
3. After the run completes: "Run finished — re-paused"

## Adjusting Configuration

### Exempt a specific agent

If an agent needs to run on its own schedule (e.g., a monitoring agent):

```bash
curl -X POST http://localhost:3100/api/plugins/paperclip-token-governor/config \
  -H "Content-Type: application/json" \
  -d '{
    "exemptAgentIds": ["<agent-id-to-exempt>"]
  }'
```

Or use the Token Governor page and click **Release** next to the agent.

### Switch to direct-manager-only policy

For stricter control where only the immediate manager can wake an agent:

```bash
curl -X POST http://localhost:3100/api/plugins/paperclip-token-governor/config \
  -H "Content-Type: application/json" \
  -d '{
    "wakePolicy": "direct_manager"
  }'
```

### Disable auto-enrollment for new agents

If you want to manually decide which agents are managed:

```bash
curl -X POST http://localhost:3100/api/plugins/paperclip-token-governor/config \
  -H "Content-Type: application/json" \
  -d '{
    "autoManageNewAgents": false
  }'
```

## Monitoring

### Plugin health

```bash
curl http://localhost:3100/api/plugins/paperclip-token-governor/health
```

Returns managed agent count and active run count.

### Scheduled jobs

```bash
# List jobs and their last run status
curl http://localhost:3100/api/plugins/paperclip-token-governor/jobs | jq
```

Two jobs should be listed:
- `reconcile-agents` — runs every minute
- `analyze-efficiency` — runs every hour

### Wake log via API

```bash
curl -X POST http://localhost:3100/api/plugins/paperclip-token-governor/bridge/data \
  -H "Content-Type: application/json" \
  -d '{ "dataKey": "wake-log" }'
```

## Uninstalling

### Disable (keeps data, resumes agents)

```bash
curl -X POST http://localhost:3100/api/plugins/paperclip-token-governor/disable
```

The plugin's `onShutdown` hook automatically resumes all managed agents.

### Uninstall (removes plugin, keeps state)

```bash
curl -X DELETE http://localhost:3100/api/plugins/paperclip-token-governor
```

### Uninstall and purge all data

```bash
curl -X DELETE "http://localhost:3100/api/plugins/paperclip-token-governor?removeData=true"
```

## Troubleshooting

### Agents stuck in "paused" after plugin crash

If the plugin crashes without running its shutdown hook, agents may remain paused. Resume them manually:

```bash
# Resume a specific agent
curl -X POST http://localhost:3100/api/agents/<agent-id>/resume

# Or re-enable the plugin (it will reconcile on startup)
curl -X POST http://localhost:3100/api/plugins/paperclip-token-governor/enable
```

### Plugin shows "error" status

Check the health endpoint for diagnostics:

```bash
curl http://localhost:3100/api/plugins/paperclip-token-governor/health | jq
```

Common causes:
- Plugin SDK version mismatch — rebuild with `pnpm build`
- Missing capabilities — the plugin requires `agents.pause`, `agents.resume`, `agents.invoke` which may not have formal capability gates yet

### Agents being woken despite policy rejection

Remember: the plugin can only control agents it has paused. If an agent is manually resumed via the API or UI between reconciliation ticks (up to 60 seconds), it could receive a native wakeup. The reconciliation job will re-pause it on the next tick.

### Wake log shows "rejected" for legitimate assignments

Check the `wakePolicy` setting. If set to `chain_of_command`, the assignor must be in the agent's `reportsTo` chain. If a peer agent assigns work, it will be rejected. Consider:
- Switching to `wakePolicy: "anyone"` for less strict environments
- Ensuring the org chart (`reportsTo` fields) is correct
