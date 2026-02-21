# super-ralph

> Reusable Ralph workflow pattern - ticket-driven development with multi-agent review loops

## Installation

```bash
bun add @evmts/super-ralph smithers-orchestrator
```

## Quick Start

### 1. Create your Smithers setup

```typescript
// smithers.ts
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";

const outputSchemas = {
  progress: z.object({ summary: z.string() }),
  discover: z.object({ tickets: z.array(z.any()) }),
  category_review: z.object({ suggestedTickets: z.array(z.any()) }),
  report: z.object({ status: z.enum(["complete", "partial", "blocked"]) }),
};

export const { smithers, outputs } = createSmithers(outputSchemas, {
  dbPath: "./workflow.db",
});
```

### 2. Create your MDX prompts

Create `prompts/UpdateProgress.mdx`:
```mdx
UPDATE PROGRESS

Your job is to update the progress report.

Completed tickets:
{props.completedTickets.map(id => `- ${id}`).join('\n')}

Read git log and write a summary to PROGRESS.md
```

Create `prompts/Discover.mdx`:
```mdx
DISCOVER NEW WORK

Your job is to discover new tickets.

Categories: {props.categories.map(c => c.id).join(', ')}

Already completed: {props.completedTicketIds.join(', ')}

Review specs and create new tickets.
```

### 3. Define your categories and target

```typescript
const categories = [
  { id: "auth", name: "Authentication" },
  { id: "api", name: "API Server" },
  { id: "db", name: "Database" },
] as const;

const target = {
  id: "my-project",
  name: "My Project",
  buildCmds: { go: "go build ./..." },
  testCmds: { go: "go test ./..." },
  fmtCmds: { go: "gofmt -w ." },
  specsPath: "docs/specs/",
  codeStyle: "Go: snake_case",
  reviewChecklist: ["Spec compliance", "Test coverage"],
  referenceFiles: ["docs/reference/"],
};
```

### 4. Create stub components

```typescript
// components/CodebaseReview.tsx
export function CodebaseReview({ target }: any) {
  // Your codebase review logic - reviews code and suggests tickets
  return null;
}

// components/TicketPipeline.tsx
export function TicketPipeline({ target, ticket, ctx }: any) {
  // Your ticket pipeline logic - Research → Plan → Implement → Test → Review → Report
  return null;
}

// components/IntegrationTest.tsx
export function IntegrationTest({ target }: any) {
  // Your integration test logic - runs tests per category
  return null;
}
```

### 5. Create your workflow

```typescript
// workflow.tsx
import { SuperRalph, useSuperRalph } from "@evmts/super-ralph";
import { smithers, outputs } from "./smithers";
import { KimiAgent, GeminiAgent, ClaudeCodeAgent } from "smithers-orchestrator";
import UpdateProgressPrompt from "./prompts/UpdateProgress.mdx";
import DiscoverPrompt from "./prompts/Discover.mdx";
import { CodebaseReview } from "./components/CodebaseReview";
import { TicketPipeline } from "./components/TicketPipeline";
import { IntegrationTest } from "./components/IntegrationTest";

export default smithers((ctx) => {
  const superRalphCtx = useSuperRalph(ctx, { categories, outputs });

  return (
    <SuperRalph
      superRalphCtx={superRalphCtx}
      ctx={ctx}
    maxConcurrency={12}
    taskRetries={3}
    categories={categories}
    outputs={outputs}
    target={target}
    CodebaseReview={CodebaseReview}
    TicketPipeline={TicketPipeline}
    IntegrationTest={IntegrationTest}
    prompts={{
      UpdateProgress: UpdateProgressPrompt,
      Discover: DiscoverPrompt,
    }}
    agents={{
      updateProgress: {
        agent: new KimiAgent({
          model: "kimi-code/kimi-for-coding",
          systemPrompt: "Summarize progress.",
          cwd: process.cwd(),
          yolo: true,
          thinking: true,
          timeoutMs: 10 * 60 * 1000,
        }),
        fallback: new GeminiAgent({
          model: "gemini-2.5-pro",
          systemPrompt: "Summarize progress.",
          cwd: process.cwd(),
          yolo: true,
          timeoutMs: 10 * 60 * 1000,
        }),
      },
      discover: {
        agent: new GeminiAgent({
          model: "gemini-2.5-pro",
          systemPrompt: "Discover new work.",
          cwd: process.cwd(),
          yolo: true,
          timeoutMs: 15 * 60 * 1000,
        }),
        fallback: new ClaudeCodeAgent({
          model: "claude-opus-4-6",
          systemPrompt: "Discover new work.",
          cwd: process.cwd(),
          dangerouslySkipPermissions: true,
          timeoutMs: 15 * 60 * 1000,
        }),
      },
    }}
  />
));
```

## Controlled Component Pattern

Use `useSuperRalph` hook to access workflow state:

```typescript
import { SuperRalph, useSuperRalph } from "@evmts/super-ralph";
import { smithers, outputs } from "./smithers";

export default smithers((ctx) => {
  const superRalphCtx = useSuperRalph(ctx, { categories, outputs });

  // Access workflow state
  console.log(`Processing ${superRalphCtx.unfinishedTickets.length} tickets`);
  console.log(`Completed: ${superRalphCtx.completedTicketIds.length}`);

  return (
    <SuperRalph
      superRalphCtx={superRalphCtx}
      maxConcurrency={12}
      taskRetries={3}
      categories={categories}
      outputs={outputs}
      target={target}
      CodebaseReview={CodebaseReview}
      TicketPipeline={TicketPipeline}
      IntegrationTest={IntegrationTest}
      prompts={{ UpdateProgress: UpdateProgressPrompt, Discover: DiscoverPrompt }}
      agents={{ /* same as above */ }}
    />
  );
});
```

## API Reference

### Props

| Prop | Type | Description |
|------|------|-------------|
| `ctx` | `SmithersCtx` | Smithers context (uncontrolled mode) |
| `superRalphCtx` | `SuperRalphContext` | Pre-computed state (controlled mode) |
| `maxConcurrency` | `number` | Max parallel tasks |
| `taskRetries` | `number` | Retry count for failed tasks |
| `categories` | `Array<{ id: string, name: string }>` | Work categories |
| `outputs` | `object` | Smithers output schemas |
| `target` | `object` | Project config (build/test/fmt cmds, etc.) |
| `CodebaseReview` | `Component` | Codebase review orchestrator |
| `TicketPipeline` | `Component` | Ticket pipeline orchestrator |
| `IntegrationTest` | `Component` | Integration test orchestrator |
| `prompts` | `{ UpdateProgress, Discover }` | MDX prompt components |
| `agents` | `{ updateProgress, discover }` | Agent configurations |
| `skipPhases` | `Set<string>` | Optional phases to skip |

### Prompts

Your MDX files should export React components:

**UpdateProgress** - Receives `{ completedTickets: string[] }`
**Discover** - Receives `{ categories, completedTicketIds, previousProgress, reviewFindings }`

### Agents

Each agent config is `{ agent: Agent, fallback: Agent }` where Agent is a Smithers agent instance (ClaudeCodeAgent, KimiAgent, GeminiAgent, CodexAgent).

### Selectors

Import selectors to extract data from SmithersCtx:

```typescript
import { selectAllTickets, selectProgressSummary, selectCodeReviews } from "@evmts/super-ralph";

const { completed, unfinished } = selectAllTickets(ctx, categories, outputs);
const progress = selectProgressSummary(ctx, outputs);
const reviews = selectCodeReviews(ctx, ticketId, outputs);
```

Available: `selectAllTickets`, `selectReviewTickets`, `selectDiscoverTickets`, `selectCompletedTicketIds`, `selectProgressSummary`, `selectTicketReport`, `selectResearch`, `selectPlan`, `selectImplement`, `selectTestResults`, `selectSpecReview`, `selectCodeReviews`

## The Ralph Pattern

```
Ralph (infinite loop)
  ├─ UpdateProgress (summarize work)
  ├─ CodebaseReview (find issues)
  ├─ Discover (find new work)
  ├─ IntegrationTest (run tests)
  └─ TicketPipeline × N (process tickets in parallel)
     └─ Worktree (isolated)
        ├─ Research → Plan → ValidationLoop → Report
        └─ ValidationLoop: Implement → Test → BuildVerify → Review → Fix
```

## License

MIT
