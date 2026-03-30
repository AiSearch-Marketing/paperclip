#!/bin/bash
# Standalone setup for Token Governor plugin
# Run this when installing outside the Paperclip monorepo
#
# Usage:
#   cd ~/paperclip-plugins/token-governor
#   bash scripts/standalone-setup.sh

set -e

echo "=== Token Governor: Standalone Setup ==="

# Step 1: Use standalone configs
echo "[1/4] Switching to standalone package.json and tsconfig..."
cp package.standalone.json package.json
cp tsconfig.standalone.json tsconfig.json

# Step 2: Install dependencies from npm
echo "[2/4] Installing dependencies from npm..."
npm install

# Step 3: Compile TypeScript
echo "[3/4] Compiling TypeScript..."
npx tsc

# Step 4: Bundle UI
echo "[4/4] Bundling UI..."
node scripts/build-ui.mjs

echo ""
echo "=== Build complete! ==="
echo ""
echo "To install in Paperclip, run:"
echo ""
echo "  curl -X POST http://localhost:3100/api/plugins/install \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"packageName\": \"$(pwd)\", \"isLocalPath\": true}'"
echo ""
