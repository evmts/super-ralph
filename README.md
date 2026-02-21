# super-ralph

> Reusable Ralph workflow pattern - ticket-driven development with multi-agent review loops

Encapsulates the proven workflow pattern extracted from Plue:
- **Ticket discovery** from codebase reviews and AI agents
- **Stacked ticket processing** with isolated worktrees
- **TDD validation loops** (Research → Plan → Implement → Test → Review → Fix)
- **Multi-agent code review** (Claude + Codex + Gemini consensus)
- **Automated priority sorting** and deduplication

## Installation

```bash
bun add @evmts/super-ralph smithers-orchestrator
```

## Usage

### Uncontrolled (pass ctx directly)

```typescript
import { SuperRalph } from "@evmts/super-ralph";
import { Workflow, smithers, outputs } from "./smithers";
import { categories } from "./categories";
import { KimiAgent, GeminiAgent, ClaudeCodeAgent } from "smithers-orchestrator";
import { CodebaseReview } from "./components/CodebaseReview";
import { TicketPipeline } from "./components/TicketPipeline";
import { IntegrationTest } from "./components/IntegrationTest";
import { categoryReferencePaths } from "./config";
import UpdateProgressPrompt from "./prompts/UpdateProgress.mdx";
import DiscoverPrompt from "./prompts/Discover.mdx";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

export default smithers((ctx) => {
  return (
    <Workflow name="my-workflow">
      <SuperRalph
        ctx={ctx}
        prompts={{
          UpdateProgress: UpdateProgressPrompt,
          Discover: DiscoverPrompt,
        }}
        agents={{
          updateProgress: {
            agent: new KimiAgent({
              model: "kimi-code/kimi-for-coding",
              systemPrompt: "Summarize progress. Read completed tickets and write a brief status update.",
              cwd: REPO_ROOT,
              yolo: true,
              thinking: true,
              timeoutMs: 10 * 60 * 1000,
            }),
            fallback: new GeminiAgent({
              model: "gemini-2.5-pro",
              systemPrompt: "Summarize progress. Read completed tickets and write a brief status update.",
              cwd: REPO_ROOT,
              yolo: true,
              timeoutMs: 10 * 60 * 1000,
            }),
          },
          discover: {
            agent: new GeminiAgent({
              model: "gemini-2.5-pro",
              systemPrompt: "Discover new work. Review specs and code to identify next tickets.",
              cwd: REPO_ROOT,
              yolo: true,
              timeoutMs: 15 * 60 * 1000,
            }),
            fallback: new ClaudeCodeAgent({
              model: "claude-opus-4-6",
              systemPrompt: "Discover new work. Review specs and code to identify next tickets.",
              cwd: REPO_ROOT,
              dangerouslySkipPermissions: true,
              timeoutMs: 15 * 60 * 1000,
            }),
          },
        }}
        config={{
          name: "my-workflow",
          maxConcurrency: 12,
          taskRetries: 3,
          categories,
          outputs,
          categoryReferencePaths,
          CodebaseReview,
          TicketPipeline,
          IntegrationTest,
          target: {
            id: "my-project",
            name: "My Project",
            buildCmds: { go: "go build ./...", rust: "cargo build" },
            testCmds: { go: "go test ./...", rust: "cargo test", e2e: "bun test" },
            fmtCmds: { go: "gofmt -w .", rust: "cargo fmt" },
            specsPath: "docs/specs/",
            codeStyle: "Go: snake_case, Rust: snake_case, JSON: snake_case",
            reviewChecklist: [
              "Spec compliance",
              "Architecture patterns",
              "Test coverage",
              "Security",
            ],
            referenceFiles: ["docs/reference/"],
          },
        }}
      />
    </Workflow>
  );
});
```

### Controlled (use hook for custom logic)

```typescript
import { SuperRalph, useSuperRalph } from "@evmts/super-ralph";
import { Workflow, smithers, outputs } from "./smithers";
import { categories } from "./categories";

export default smithers((ctx) => {
  // Use hook to extract workflow state
  const superRalphCtx = useSuperRalph(ctx, { categories, outputs });

  // You can now access and manipulate state before passing to SuperRalph
  console.log(`Processing ${superRalphCtx.unfinishedTickets.length} tickets`);

  return (
    <Workflow name="my-workflow">
      <SuperRalph
        superRalphCtx={superRalphCtx}  {/* Pass controlled context */}
        prompts={{ /* ... */ }}
        agents={{ /* ... */ }}
        config={{ /* ... */ }}
      />
    </Workflow>
  );
});
```

The controlled pattern gives you access to:
- `completedTicketIds` - IDs of finished tickets
- `unfinishedTickets` - Tickets to process
- `reviewFindings` - Summary of codebase review findings
- `progressSummary` - Latest progress summary

Use this when you need to:
- Log workflow state
- Add custom logic before rendering
- Filter or transform tickets
- Pass state to other components

## What You Provide

### Prompts (MDX files)
Your domain-specific instructions for workflow steps that SuperRalph orchestrates directly. These are React components (compiled from MDX) that receive props and render the prompt text.

**Required:**
- `UpdateProgress` - How to summarize progress across completed tickets
  - Props: `{ completedTickets: string[] }`
- `Discover` - How to identify new work from specs and code
  - Props: `{ categories: any[]; completedTicketIds: string[]; previousProgress: string | null; reviewFindings: string | null }`

All other prompts (Research, Plan, Implement, Test, BuildVerify, SpecReview, ReviewFix, Report, CategoryReview, CodeReview, IntegrationTest) are handled by your child components (`CodebaseReview`, `TicketPipeline`, `IntegrationTest`) which you pass in config.

### Agents
Your choice of AI models and configurations for workflow steps that SuperRalph orchestrates directly.

**Required:**
- `updateProgress` - `{ agent: Agent, fallback: Agent }` for progress summarization
- `discover` - `{ agent: Agent, fallback: Agent }` for ticket discovery

All other agents (for Research, Plan, Implement, Test, etc.) are configured in your child components (`CodebaseReview`, `TicketPipeline`, `IntegrationTest`).

Each agent is a Smithers agent instance (ClaudeCodeAgent, KimiAgent, GeminiAgent, CodexAgent, etc.) with:
- Model selection (e.g., "claude-sonnet-4-6", "gpt-5.3-codex")
- System prompt (task-specific instructions)
- Timeout in milliseconds
- Permissions (yolo/dangerouslySkipPermissions)
- Working directory (cwd)

### Config
All project-specific configuration:

- `name` - Workflow name
- `maxConcurrency` - Max parallel tasks
- `taskRetries` - Retry count for failed tasks
- `categories` - Your project's work categories (e.g., `[{ id: "auth", name: "Authentication" }, ...]`)
- `outputs` - Your Smithers output schemas
- `categoryReferencePaths` - Map category IDs to reference doc paths
- `target` - Your project config:
  - `buildCmds` - Build commands by language (go, rust, etc.)
  - `testCmds` - Test commands by type
  - `fmtCmds` - Format commands
  - `specsPath` - Path to specs directory
  - `codeStyle` - Code style guidelines
  - `reviewChecklist` - Code review checklist items
  - `referenceFiles` - Reference documentation paths
- `CodebaseReview` - Your codebase review orchestrator component
- `TicketPipeline` - Your ticket pipeline orchestrator component
- `IntegrationTest` - Your integration test orchestrator component

## What SuperRalph Provides

### The `<SuperRalph />` Component
Orchestrates the entire Ralph workflow:
- Infinite Ralph loop
- Parallel execution of phases
- Ticket aggregation and deduplication
- Worktree isolation per ticket

### Selectors
Reusable data extraction functions:

```typescript
import { selectAllTickets, selectProgressSummary, selectCodeReviews } from "@evmts/super-ralph";

const { completed, unfinished } = selectAllTickets(ctx, categories, outputs);
const progress = selectProgressSummary(ctx, outputs);
const reviews = selectCodeReviews(ctx, ticketId, outputs);
```

Available selectors:
- `selectAllTickets()` - All tickets (merged, deduplicated, sorted by priority)
- `selectReviewTickets()` - Tickets from codebase reviews
- `selectDiscoverTickets()` - Tickets from AI discovery
- `selectCompletedTicketIds()` - IDs of completed tickets
- `selectProgressSummary()` - Latest progress summary
- `selectTicketReport()` - Ticket completion report
- `selectResearch()` - Research context
- `selectPlan()` - Implementation plan
- `selectImplement()` - Implementation output
- `selectTestResults()` - Test results
- `selectSpecReview()` - Spec review
- `selectCodeReviews()` - Merged code reviews (Claude + Codex + Gemini)

## The Ralph Pattern

```
Ralph (infinite loop)
  ├─ Parallel
  │  ├─ UpdateProgress (summarize completed work)
  │  ├─ CodebaseReview (identify issues → tickets)
  │  ├─ Discover (identify new work → tickets)
  │  ├─ IntegrationTest (run category-level tests)
  │  └─ TicketPipeline (for each unfinished ticket)
  │     └─ Worktree (isolated git worktree)
  │        ├─ Research (gather context)
  │        ├─ Plan (TDD plan)
  │        ├─ ValidationLoop (until reviews pass)
  │        │  ├─ Implement (TDD: tests first)
  │        │  ├─ Test (run all tests)
  │        │  ├─ BuildVerify (check compilation)
  │        │  ├─ Parallel
  │        │  │  ├─ SpecReview (check against specs)
  │        │  │  └─ CodeReview (multi-agent review)
  │        │  └─ ReviewFix (fix issues if any)
  │        └─ Report (mark complete)
  └─ (repeat until no work remains)
```

## License

MIT
