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

```typescript
import { SuperRalph } from "@evmts/super-ralph";
import { smithers, outputs } from "./smithers";
import { categories } from "./categories";
import { KimiAgent, GeminiAgent, ClaudeCodeAgent } from "smithers-orchestrator";
import UpdateProgressPrompt from "./prompts/UpdateProgress.mdx";
import DiscoverPrompt from "./prompts/Discover.mdx";

export default smithers((ctx) => {
  const target = getTarget();

  return (
    <Workflow name="my-workflow">
      <SuperRalph
        ctx={ctx}
        target={target}
        prompts={{
          UpdateProgress: UpdateProgressPrompt,
          Discover: DiscoverPrompt,
          // ... your other prompts
        }}
        agents={{
          updateProgress: {
            agent: new KimiAgent({ /* ... */ }),
            fallback: new GeminiAgent({ /* ... */ }),
          },
          discover: {
            agent: new GeminiAgent({ /* ... */ }),
            fallback: new ClaudeCodeAgent({ /* ... */ }),
          },
          // ... your other agents
        }}
        config={{
          name: "my-workflow",
          maxConcurrency: 12,
          taskRetries: 3,
          categories,
          outputs,
          categoryReferencePaths: { /* ... */ },
          CodebaseReview: MyCodebaseReview,
          TicketPipeline: MyTicketPipeline,
          IntegrationTest: MyIntegrationTest,
        }}
      />
    </Workflow>
  );
});
```

## What You Provide

### Prompts (MDX files)
Your domain-specific instructions for each step:
- `UpdateProgress` - How to summarize progress
- `Discover` - How to identify new work
- `Research`, `Plan`, `Implement`, etc. - Step-specific instructions

### Agents (Smithers agents)
Your choice of AI models and configurations:
- Which models to use (Claude, Codex, Gemini, Kimi, etc.)
- System prompts, timeouts, permissions
- Fallback agents for each step

### Config
- `categories` - Your project's work categories
- `outputs` - Your Smithers output schemas
- `categoryReferencePaths` - Category-specific reference docs
- `CodebaseReview`, `TicketPipeline`, `IntegrationTest` - Your orchestrator components

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
