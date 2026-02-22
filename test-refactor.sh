#!/bin/bash
# Quick test of the refactored Super Ralph CLI

set -e

echo "🧪 Testing Super Ralph Refactored CLI"
echo "======================================"
echo ""

# Test 1: Help command
echo "Test 1: Help command"
bun src/cli/index.ts --help
echo "✅ Help command works"
echo ""

# Test 2: Dry run to generate workflow files
echo "Test 2: Dry run workflow generation"
bun src/cli/index.ts "Test workflow refactoring" --dry-run --skip-questions --cwd /tmp/test-sr
echo "✅ Dry run completed"
echo ""

# Test 3: Check generated files
echo "Test 3: Verify generated files exist"
if [ -f "/tmp/test-sr/.super-ralph/generated/workflow.tsx" ]; then
  echo "✅ workflow.tsx generated"
else
  echo "❌ workflow.tsx missing"
  exit 1
fi

if [ -f "/tmp/test-sr/.super-ralph/generated/preload.ts" ]; then
  echo "✅ preload.ts generated"
else
  echo "❌ preload.ts missing"
  exit 1
fi

if [ -f "/tmp/test-sr/.super-ralph/generated/bunfig.toml" ]; then
  echo "✅ bunfig.toml generated"
else
  echo "❌ bunfig.toml missing"
  exit 1
fi

echo ""
echo "Test 4: Verify workflow structure"
if grep -q "ClarifyingQuestions" /tmp/test-sr/.super-ralph/generated/workflow.tsx; then
  echo "✅ ClarifyingQuestions component present"
else
  echo "❌ ClarifyingQuestions component missing"
  exit 1
fi

if grep -q "InterpretConfig" /tmp/test-sr/.super-ralph/generated/workflow.tsx; then
  echo "✅ InterpretConfig component present"
else
  echo "❌ InterpretConfig component missing"
  exit 1
fi

if grep -q "Monitor" /tmp/test-sr/.super-ralph/generated/workflow.tsx; then
  echo "✅ Monitor component present"
else
  echo "❌ Monitor component missing"
  exit 1
fi

if grep -q "SuperRalph" /tmp/test-sr/.super-ralph/generated/workflow.tsx; then
  echo "✅ SuperRalph component present"
else
  echo "❌ SuperRalph component missing"
  exit 1
fi

if grep -q "<Parallel>" /tmp/test-sr/.super-ralph/generated/workflow.tsx; then
  echo "✅ Parallel execution structure present"
else
  echo "❌ Parallel execution missing"
  exit 1
fi

echo ""
echo "🎉 All tests passed!"
echo ""
echo "Generated workflow:"
head -50 /tmp/test-sr/.super-ralph/generated/workflow.tsx
