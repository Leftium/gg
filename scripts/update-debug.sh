#!/bin/bash
set -e

echo "📦 Updating bundled debug library..."

# Check if debug is installed
if [ ! -d "node_modules/debug" ]; then
    echo "❌ debug not found in node_modules. Run 'pnpm install' first."
    exit 1
fi

# Get current version
DEBUG_VERSION=$(node -p "require('./node_modules/debug/package.json').version")
echo "✓ Found debug version: $DEBUG_VERSION"

# Backup existing files
if [ -d "src/lib/debug" ]; then
    echo "📋 Backing up existing debug files..."
    cp -r src/lib/debug src/lib/debug.backup
fi

# Create directory structure
mkdir -p src/lib/debug/src
mkdir -p src/lib/debug/ms

# Copy debug files
echo "📂 Copying debug source files..."
cp node_modules/debug/src/*.js src/lib/debug/src/
cp node_modules/debug/package.json src/lib/debug/

# Copy ms dependency
echo "📂 Copying ms dependency..."
cp node_modules/ms/index.js src/lib/debug/ms/
cp node_modules/ms/package.json src/lib/debug/ms/

echo "✓ Debug files copied"
echo ""
echo "⚠️  IMPORTANT: Check if your patches still apply!"
echo "   Review changes in: src/lib/debug/src/"
echo ""
echo "   Expected patches:"
echo "   - src/lib/debug/src/browser.js line ~150: time diff before namespace"
echo "   - src/lib/debug/src/node.js line ~172: time diff before namespace"
echo ""
echo "   Patch format:"
echo '   `${("+" + module.exports.humanize(this.diff)).padStart(6)} ${this.namespace}`'
echo ""
echo "✓ Done! Next steps:"
echo "   1. Review git diff to see what changed"
echo "   2. Verify patches are still present"
echo "   3. Test: pnpm dev"
echo "   4. Test: pnpm prepack"
echo "   5. Test in consumer: cd test-consumer && npm install ../leftium-gg-*.tgz"
