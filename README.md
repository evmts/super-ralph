# super-ralph

> Reusable Ralph workflow - ticket-driven development with multi-agent review loops

Complete workflow framework with built-in orchestrators. Just configure agents, provide specs, and go.

## Installation

```bash
bun add @evmts/super-ralph smithers-orchestrator
```

## Usage

```tsx
import { SuperRalph, useSuperRalph, ralphOutputSchemas } from "@evmts/super-ralph";
import { createSmithers } from "smithers-orchestrator";
import { KimiAgent, GeminiAgent, ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";

// 1. Create Smithers with built-in schemas
const { smithers, outputs } = createSmithers(ralphOutputSchemas, { dbPath: "./workflow.db" });

// 2. Define your project categories
const categories = [
  { id: "auth", name: "Authentication" },
  { id: "api", name: "API Server" },
];

// 3. Create workflow
export default smithers((ctx) => {
  const superRalphCtx = useSuperRalph(ctx, {
    categories,
    outputs,
    target: { id: "my-project", name: "My Project" },
  });

  return (
    <SuperRalph
      superRalphCtx={superRalphCtx}
      maxConcurrency={12}
      taskRetries={3}
      updateProgress={
        <SuperRalph.UpdateProgress
          agent={new KimiAgent({ model: "kimi-code/kimi-for-coding", cwd: process.cwd(), yolo: true })}
          projectName="My Project"
          progressFile="PROGRESS.md"
        />
      }
      discover={
        <SuperRalph.Discover
          agent={new GeminiAgent({ model: "gemini-2.5-pro", cwd: process.cwd(), yolo: true })}
          specsPath="docs/specs/"
          referenceFiles={["docs/reference/"]}
        />
      }
      integrationTest={
        <SuperRalph.IntegrationTest
          agent={new ClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() })}
          categories={categories}
          categoryTestSuites={{
            auth: { suites: ["Auth tests"], setupHints: ["go test ./internal/auth/..."], testDirs: ["internal/auth/"] },
          }}
          findingsFile="docs/test-suite-findings.md"
        />
      }
      categoryReview={
        <SuperRalph.CategoryReview
          agent={new CodexAgent({ model: "gpt-5.3-codex", cwd: process.cwd(), yolo: true })}
          categoryDirs={{
            auth: ["internal/auth/"],
            api: ["internal/routes/", "internal/services/"],
          }}
        />
      }
      research={
        <SuperRalph.Research
          agent={new ClaudeCodeAgent({ model: "claude-opus-4-6", cwd: process.cwd() })}
          fallbackAgent={new GeminiAgent({ model: "gemini-2.5-pro", cwd: process.cwd(), yolo: true })}
          contextDir="docs/context"
          referencePaths={["docs/specs/", "docs/reference/"]}
        />
      }
      plan={
        <SuperRalph.Plan
          agent={new CodexAgent({ model: "gpt-5.3-codex", cwd: process.cwd(), yolo: true })}
          fallbackAgent={new GeminiAgent({ model: "gemini-2.5-pro", cwd: process.cwd(), yolo: true })}
          planDir="docs/plans"
          tddPatterns={["Write tests FIRST, then implementation"]}
          commitPrefix="📝"
          mainBranch="main"
        />
      }
      implement={
        <SuperRalph.Implement
          agent={new CodexAgent({ model: "gpt-5.3-codex", cwd: process.cwd(), yolo: true })}
          fallbackAgent={new ClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() })}
          testWritingGuidance={["Write unit tests AND integration tests"]}
          implementationGuidance={["Follow project architecture patterns"]}
          formatterCommands={["gofmt -w .", "cargo fmt"]}
          verifyCommands={["make build"]}
          architectureRules={["Follow specs in docs/specs/"]}
          commitPrefix="✨"
          mainBranch="main"
          emojiPrefixes="✨ feat, 🐛 fix, ♻️ refactor, 📝 docs, 🧪 test"
        />
      }
      test={
        <SuperRalph.Test
          agent={new ClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() })}
          testSuites={[
            { name: "Go Tests", command: "go test ./...", description: "Run all Go unit tests" },
            { name: "Rust Tests", command: "cargo test", description: "Run all Rust tests" },
            { name: "E2E Tests", command: "bun test", description: "Run E2E tests" },
          ]}
          fixCommitPrefix="🐛 fix"
          mainBranch="main"
        />
      }
      buildVerify={
        <SuperRalph.BuildVerify
          agent={new KimiAgent({ model: "kimi-code/kimi-for-coding", cwd: process.cwd(), yolo: true })}
          buildCommand="make build"
          verifyCommands={["go build ./...", "cargo build"]}
        />
      }
      specReview={
        <SuperRalph.SpecReview
          agent={new CodexAgent({ model: "gpt-5.3-codex", cwd: process.cwd(), yolo: true })}
          specChecks={[
            { name: "Architecture", items: ["Router pattern", "Service layer", "Error format"] },
            { name: "Conventions", items: ["snake_case JSON", "Timestamps ISO 8601"] },
          ]}
        />
      }
      codeReview={
        <SuperRalph.CodeReview
          agent={new ClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() })}
          additionalAgents={[
            {
              agent: new CodexAgent({ model: "gpt-5.3-codex", cwd: process.cwd(), yolo: true }),
              outputKey: "code_review_codex",
            },
            {
              agent: new GeminiAgent({ model: "gemini-2.5-pro", cwd: process.cwd(), yolo: true }),
              outputKey: "code_review_gemini",
            },
          ]}
          reviewChecklist={["Code quality", "Error handling", "Test coverage"]}
        />
      }
      reviewFix={
        <SuperRalph.ReviewFix
          agent={new ClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() })}
          validationCommands={["make build", "go test ./..."]}
          commitPrefix="🐛 fix"
          mainBranch="main"
          emojiPrefixes="🐛 fix, ♻️ refactor"
        />
      }
      report={
        <SuperRalph.Report
          agent={new ClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() })}
          fallbackAgent={new KimiAgent({ model: "kimi-code/kimi-for-coding", cwd: process.cwd(), yolo: true })}
          reportDir="docs/reports"
        />
      }
    />
  );
});
```

## What's Included

### Built-in Orchestrators

✅ **TicketPipeline** - Research → Plan → ValidationLoop → Report
✅ **ValidationLoop** - Implement → Test → Build → (Spec+Code Review) → Fix (loops until approved)
✅ **CodebaseReview** - Parallel category reviews across all categories

### Built-in Compound Components

All workflow steps are provided as compound components:

- `<SuperRalph.UpdateProgress />` - Update progress file
- `<SuperRalph.Discover />` - Discover new tickets from specs
- `<SuperRalph.IntegrationTest />` - Run integration tests per category
- `<SuperRalph.CategoryReview />` - Review codebase category
- `<SuperRalph.Research />` - Gather context for ticket
- `<SuperRalph.Plan />` - Create TDD implementation plan
- `<SuperRalph.Implement />` - Implement ticket (TDD)
- `<SuperRalph.Test />` - Run all tests
- `<SuperRalph.BuildVerify />` - Verify build passes
- `<SuperRalph.SpecReview />` - Review spec compliance
- `<SuperRalph.CodeReview />` - Review code quality (multi-agent)
- `<SuperRalph.ReviewFix />` - Fix review issues
- `<SuperRalph.Report />` - Write final ticket report

### Generic Prompts

All prompts are parameterized and project-agnostic. Located in `src/prompts/`:

- `UpdateProgress.mdx`, `Discover.mdx`, `IntegrationTest.mdx`
- `CategoryReview.mdx`, `Research.mdx`, `Plan.mdx`
- `Implement.mdx`, `Test.mdx`, `BuildVerify.mdx`
- `SpecReview.mdx`, `CodeReview.mdx`, `ReviewFix.mdx`, `Report.mdx`

### Output Schemas

Pre-built Zod schemas for all workflow steps:

```typescript
import { ralphOutputSchemas } from "@evmts/super-ralph";

// Contains: progress, discover, category_review, research, plan, implement,
// test_results, build_verify, spec_review, code_review, review_fix, report,
// integration_test
```

### Selectors

Data extraction utilities:

```typescript
import {
  selectAllTickets,
  selectReviewTickets,
  selectDiscoverTickets,
  selectCompletedTicketIds,
  selectProgressSummary,
  selectTicketReport,
  selectResearch,
  selectPlan,
  selectImplement,
  selectTestResults,
  selectSpecReview,
  selectCodeReviews,
} from "@evmts/super-ralph";

const { completed, unfinished } = selectAllTickets(ctx, categories, outputs);
const research = selectResearch(ctx, ticketId);
```

## Component Props Reference

### UpdateProgress

- `agent` - Primary agent
- `fallbackAgent` - Optional fallback
- `projectName` - Project name
- `progressFile` - Path to progress file
- `commitMessage` - Optional custom commit message

### Discover

- `agent` - Primary agent
- `fallbackAgent` - Optional fallback
- `specsPath` - Path to specs directory
- `referenceFiles` - Array of reference paths

### IntegrationTest

- `agent` - Primary agent
- `fallbackAgent` - Optional fallback
- `categories` - Array of `{ id, name }`
- `categoryTestSuites` - Map of category ID to `{ suites, setupHints, testDirs }`
- `findingsFile` - Path to findings file

### CategoryReview

- `agent` - Primary agent
- `fallbackAgent` - Optional fallback
- `categoryDirs` - Optional map of category ID to directory paths

### Research

- `agent` - Primary agent
- `fallbackAgent` - Optional fallback
- `contextDir` - Directory for context files (default: `docs/context`)
- `referencePaths` - Optional array of reference paths

### Plan

- `agent` - Primary agent
- `fallbackAgent` - Optional fallback
- `planDir` - Directory for plan files (default: `docs/plans`)
- `tddPatterns` - Optional TDD guidance
- `commitPrefix` - Optional commit emoji/prefix
- `mainBranch` - Main branch name (default: `main`)

### Implement

- `agent` - Primary agent
- `fallbackAgent` - Optional fallback
- `testWritingGuidance` - Optional test writing rules
- `implementationGuidance` - Optional implementation rules
- `formatterCommands` - Optional formatter commands
- `verifyCommands` - Optional verification commands
- `architectureRules` - Optional architecture rules
- `commitPrefix` - Optional commit emoji/prefix
- `mainBranch` - Main branch name
- `emojiPrefixes` - Optional emoji guide

### Test

- `agent` - Primary agent
- `fallbackAgent` - Optional fallback
- `testSuites` - Optional array of `{ name, command, description, skipCondition?, skipNote? }`
- `fixCommitPrefix` - Optional fix commit prefix
- `mainBranch` - Main branch name

### BuildVerify

- `agent` - Primary agent
- `fallbackAgent` - Optional fallback
- `buildCommand` - Optional build command
- `verifyCommands` - Optional verification commands

### SpecReview

- `agent` - Primary agent
- `fallbackAgent` - Optional fallback
- `specChecks` - Optional array of `{ name, items }`
- `testResults` - Optional test result overrides

### CodeReview

- `agent` - Primary agent
- `fallbackAgent` - Optional fallback
- `additionalAgents` - Optional array of `{ agent, fallbackAgent?, outputKey }`
- `reviewChecklist` - Optional review checklist items

### ReviewFix

- `agent` - Primary agent
- `fallbackAgent` - Optional fallback
- `validationCommands` - Optional validation commands
- `commitPrefix` - Optional commit emoji/prefix
- `mainBranch` - Main branch name
- `emojiPrefixes` - Optional emoji guide

### Report

- `agent` - Primary agent
- `fallbackAgent` - Optional fallback
- `reportDir` - Directory for reports (default: `docs/reports`)

## How It Works

1. **Parallel workflow phases:**
   - UpdateProgress - Updates progress file
   - CodebaseReview - Reviews all categories in parallel
   - Discover - Discovers new tickets from specs
   - IntegrationTest - Runs integration tests per category

2. **Per-ticket processing (in worktrees):**
   - TicketPipeline orchestrates Research → Plan → ValidationLoop → Report
   - ValidationLoop runs Implement → Test → Build → Reviews → Fix until approved

3. **Infinite Ralph loop:**
   - Repeats until `until` condition is met (default: `false` = infinite)
   - Use `skipPhases` to skip specific phases (e.g., `new Set(["PROGRESS"])`)

## Advanced: Skip Phases

```tsx
<SuperRalph
  superRalphCtx={superRalphCtx}
  maxConcurrency={12}
  taskRetries={3}
  skipPhases={new Set(["CODEBASE_REVIEW", "INTEGRATION_TEST"])}
  // ... components
/>
```

Available skip keys: `PROGRESS`, `CODEBASE_REVIEW`, `DISCOVER`, `INTEGRATION_TEST`

## Philosophy

**Zero boilerplate.** Super Ralph provides a complete workflow framework where you just configure agents and provide your project specs. All orchestration, prompts, and schemas are built-in.

**Compound component pattern.** Each step is configurable via compound components, giving you full control over agents and behavior without rebuilding orchestrators.

**Multi-agent by default.** Every step supports primary + fallback agents. Code review supports N agents in parallel.

**TDD first.** The workflow enforces test-driven development: tests before implementation, review loops until approved, atomic commits.

## License

MIT
