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

## Quick Start

```typescript
import { createSmithers } from "smithers-orchestrator";
import { SuperRalph } from "@evmts/super-ralph";
import { KimiAgent, GeminiAgent, ClaudeCodeAgent } from "smithers-orchestrator";
import { z } from "zod";

// 1. Define your output schemas
const outputSchemas = {
  progress: z.object({ summary: z.string() }),
  discover: z.object({ tickets: z.array(z.any()) }),
  category_review: z.object({ suggestedTickets: z.array(z.any()), overallSeverity: z.string() }),
  report: z.object({ status: z.enum(["complete", "partial", "blocked"]) }),
};

// 2. Create Smithers instance
const { smithers, outputs } = createSmithers(outputSchemas, { dbPath: "./workflow.db" });

// 3. Define your categories
const categories = [
  { id: "auth", name: "Authentication" },
  { id: "api", name: "API Server" },
  { id: "db", name: "Database" },
] as const;

// 4. Define your project config
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

// 5. Create your MDX prompts
// prompts/UpdateProgress.mdx:
// ```
// Your job is to update the progress report.
//
// Completed tickets: {props.completedTickets.join(", ")}
//
// Read git log and write a summary to PROGRESS.md
// ```

// prompts/Discover.mdx:
// ```
// Your job is to discover new work.
//
// Categories: {props.categories.map(c => c.id).join(", ")}
// Previously completed: {props.completedTicketIds.join(", ")}
//
// Review specs and create new tickets.
// ```

import UpdateProgressPrompt from "./prompts/UpdateProgress.mdx";
import DiscoverPrompt from "./prompts/Discover.mdx";

// 6. Create your child components (simplified examples)
const CodebaseReview = ({ target }: any) => null; // Your implementation
const TicketPipeline = ({ target, ticket, ctx }: any) => null; // Your implementation
const IntegrationTest = ({ target }: any) => null; // Your implementation

// 7. Use SuperRalph
export default smithers((ctx) => (
  <SuperRalph
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

Use `useSuperRalph` hook to access workflow state before rendering:

```typescript
import { SuperRalph, useSuperRalph } from "@evmts/super-ralph";
// ... other imports from above

export default smithers((ctx) => {
  const superRalphCtx = useSuperRalph(ctx, { categories, outputs });

  // Access workflow state
  console.log(`Processing ${superRalphCtx.unfinishedTickets.length} tickets`);
  console.log(`Completed: ${superRalphCtx.completedTicketIds.length}`);

  return (
    <SuperRalph
      superRalphCtx={superRalphCtx}  {/* Pass controlled state instead of ctx */}
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