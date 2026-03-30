# Installing the Token Governor Plugin

## Prerequisites

- A running Paperclip instance (installed via `npx paperclipai` or from source)
- Node.js 20+
- Board-level access (plugin management requires admin privileges)

## Quick Install (Standalone — no monorepo needed)

This is the recommended method if you installed Paperclip via `npx paperclipai`.

### Step 1: Download the plugin

```bash
cd /tmp
git clone --depth 1 --branch claude/optimize-tokens-agents-7j9BQ \
  https://github.com/AiSearch-Marketing/paperclip.git paperclip-fork

mkdir -p ~/paperclip-plugins
cp -r /tmp/paperclip-fork/packages/plugins/examples/plugin-token-governor \
  ~/paperclip-plugins/token-governor

rm -rf /tmp/paperclip-fork
```

### Step 2: Build the plugin

```bash
cd ~/paperclip-plugins/token-governor
bash scripts/standalone-setup.sh
```

This script:
1. Switches to standalone `package.json` (npm dependencies instead of workspace references)
2. Switches to standalone `tsconfig.json` (no monorepo base config needed)
3. Runs `npm install` to fetch `@paperclipai/plugin-sdk` and `@paperclipai/shared` from npm
4. Compiles TypeScript to `dist/`
5. Bundles the React UI to `dist/ui/`

### Step 3: Install in Paperclip

```bash
curl -X POST http://localhost:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d "{\"packageName\": \"$HOME/paperclip-plugins/token-governor\", \"isLocalPath\": true}"
```

### Step 4: Verify

```bash
curl -s http://localhost:3100/api/plugins | python3 -m json.tool
```

Look for `"pluginKey": "paperclip-token-governor"` with `"status": "ready"`.

You should now see **Token Governor** in the Plugin Manager at **Instance Settings > Plugins**, and a new **Token Governor** page in the sidebar navigation.

## Manual Build (if the setup script fails)

If the standalone setup script doesn't work on your system, run the steps manually:

```bash
cd ~/paperclip-plugins/token-governor

cp package.standalone.json package.json
cp tsconfig.standalone.json tsconfig.json

npm install

npx tsc

node scripts/build-ui.mjs
```

Then install via the API as in Step 3 above.

## Install from Monorepo (Development)

If you're running Paperclip from a cloned source repo with `pnpm dev`:

```bash
cd packages/plugins/examples/plugin-token-governor
pnpm install
pnpm build
```

Then either:
- **Plugin Manager UI**: Navigate to Instance Settings > Plugins. If the `BUNDLED_PLUGIN_EXAMPLES` entry is present, Token Governor appears under Available Plugins — click Install.
- **API**: `curl -X POST http://localhost:3100/api/plugins/install -H "Content-Type: application/json" -d "{\"packageName\": \"$(pwd)\", \"isLocalPath\": true}"`

## Post-Installation Setup

### 1. Configure the plugin

Navigate to **Instance Settings** > **Plugins** > **Token Governor** > **Configure**, or use the API:

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

1. Open the Token Governor page: `/<your-company-prefix>/token-governor`
2. Click **Enroll All Agents**

### 3. Verify agents are managed

After enrollment, non-exempt agents should show as `status: "paused"`:

```bash
curl -s http://localhost:3100/api/companies/<company-id>/agents | python3 -m json.tool
```

Expected: CEO shows `"status": "idle"`, other agents show `"status": "paused"`.

### 4. Test the wake flow

Assign an issue to a managed agent from the CEO. Watch the Token Governor page — you should see:
1. A wake log entry: "Assignment approved (chain_of_command)"
2. The agent's status change to "running"
3. After the run completes: "Run finished — re-paused"

## Configuration Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `exemptRoles` | `["ceo"]` | Agent roles that are never paused |
| `exemptAgentIds` | `[]` | Specific agent IDs to exclude |
| `wakePolicy` | `"chain_of_command"` | Who can wake: `chain_of_command`, `direct_manager`, or `anyone` |
| `allowMentionWakes` | `true` | @mentions in comments can wake agents |
| `allowDirectUserWakes` | `true` | Human users can always wake any agent |
| `autoManageNewAgents` | `true` | New agents are auto-enrolled |
| `maxWakeLogEntries` | `200` | Wake log entries to retain |

## Updating the Plugin

After pulling a new version of the plugin source:

```bash
cd ~/paperclip-plugins/token-governor
bash scripts/standalone-setup.sh

curl -X POST http://localhost:3100/api/plugins/paperclip-token-governor/upgrade \
  -H "Content-Type: application/json" \
  -d "{\"localPath\": \"$HOME/paperclip-plugins/token-governor\"}"
```

## Uninstalling

### Disable (keeps data, resumes all managed agents)

```bash
curl -X POST http://localhost:3100/api/plugins/paperclip-token-governor/disable
```

### Uninstall completely

```bash
curl -X DELETE "http://localhost:3100/api/plugins/paperclip-token-governor?removeData=true"
```

## Troubleshooting

### Agents stuck in "paused" after plugin crash

Resume them manually, or re-enable the plugin (it reconciles on startup):

```bash
curl -X POST http://localhost:3100/api/plugins/paperclip-token-governor/enable
```

### Build fails with "Cannot find module @paperclipai/plugin-sdk"

Make sure you used `package.standalone.json` (not the monorepo version):

```bash
cp package.standalone.json package.json
npm install
```

### Plugin shows "error" status

```bash
curl -s http://localhost:3100/api/plugins/paperclip-token-governor/health | python3 -m json.tool
```

Common causes:
- Plugin SDK version mismatch — rebuild with `bash scripts/standalone-setup.sh`
- `dist/` directory missing — run the build step again

### Wake log shows "rejected" for legitimate assignments

The `wakePolicy` setting may be too strict. If set to `chain_of_command`, the assignor must be in the agent's `reportsTo` chain. Try `"anyone"` for less strict environments.
