# super-ralph

> Reusable Ralph workflow - ticket-driven development with multi-agent review loops

Compound component pattern. Generic prompts included. Zero boilerplate.

## Installation

```bash
bun add @evmts/super-ralph smithers-orchestrator
```

## Usage

```typescript
import { SuperRalph, useSuperRalph, ralphOutputSchemas } from "@evmts/super-ralph";
import { createSmithers } from "smithers-orchestrator";
import { KimiAgent, GeminiAgent, ClaudeCodeAgent } from "smithers-orchestrator";
import { CodebaseReview } from "./components/CodebaseReview";
import { TicketPipeline } from "./components/TicketPipeline";

// 1. Create Smithers with built-in schemas
const { smithers, outputs } = createSmithers(ralphOutputSchemas, { dbPath: "./workflow.db" });

// 2. Create workflow
export default smithers((ctx) => {
  const superRalphCtx = useSuperRalph(ctx, {
    categories: [
      { id: "auth", name: "Authentication" },
      { id: "api", name: "API Server" },
    ],
    outputs,
    target: {
      id: "my-project",
      name: "My Project",
      buildCmds: { go: "go build ./..." },
      testCmds: { go: "go test ./..." },
      fmtCmds: { go: "gofmt -w ." },
      specsPath: "docs/specs/",
      codeStyle: "Go: snake_case",
      reviewChecklist: ["Spec compliance"],
      referenceFiles: ["docs/reference/"],
    },
  });

  return (
    <SuperRalph
      superRalphCtx={superRalphCtx}
      maxConcurrency={12}
      taskRetries={3}
      updateProgress={
        <SuperRalph.UpdateProgress
        agent={new KimiAgent({
          model: "kimi-code/kimi-for-coding",
          systemPrompt: "Summarize progress.",
          cwd: process.cwd(),
          yolo: true,
          thinking: true,
          timeoutMs: 10 * 60 * 1000,
        })}
        fallbackAgent={new GeminiAgent({
          model: "gemini-2.5-pro",
          systemPrompt: "Summarize progress.",
          cwd: process.cwd(),
          yolo: true,
          timeoutMs: 10 * 60 * 1000,
        })}
        projectName="My Project"
        progressFile="PROGRESS.md"
        />
      }
      discover={
        <SuperRalph.Discover
        agent={new GeminiAgent({
          model: "gemini-2.5-pro",
          systemPrompt: "Discover new work.",
          cwd: process.cwd(),
          yolo: true,
          timeoutMs: 15 * 60 * 1000,
        })}
        fallbackAgent={new ClaudeCodeAgent({
          model: "claude-opus-4-6",
          systemPrompt: "Discover new work.",
          cwd: process.cwd(),
          dangerouslySkipPermissions: true,
          timeoutMs: 15 * 60 * 1000,
        })}
        specsPath="docs/specs/"
        referenceFiles={["docs/reference/"]}
        />
      }
      integrationTest={
        <SuperRalph.IntegrationTest
        agent={new ClaudeCodeAgent({
          model: "claude-sonnet-4-6",
          systemPrompt: "Run integration tests.",
          cwd: process.cwd(),
          dangerouslySkipPermissions: true,
          timeoutMs: 20 * 60 * 1000,
        })}
        fallbackAgent={new KimiAgent({
          model: "kimi-code/kimi-for-coding",
          systemPrompt: "Run integration tests.",
          cwd: process.cwd(),
          yolo: true,
          thinking: true,
          timeoutMs: 20 * 60 * 1000,
        })}
        categoryTestSuites={{
          "auth": {
            suites: ["Auth unit tests"],
            setupHints: ["Run go test ./internal/auth/..."],
            testDirs: ["internal/auth/"],
          },
        }}
        findingsFile="docs/test-suite-findings.md"
        />
      }
      codebaseReview={
        <SuperRalph.CodebaseReview target={superRalphCtx.target}>
          <CodebaseReview />
        </SuperRalph.CodebaseReview>
      }
      ticketPipeline={
        <SuperRalph.TicketPipeline target={superRalphCtx.target}>
          <TicketPipeline />
        </SuperRalph.TicketPipeline>
      }
    />
  );
});
```

## What You Provide

**2 orchestrator components:**
- `CodebaseReview` - Reviews code per category, suggests fix tickets
- `TicketPipeline` - Implements tickets (Research → Plan → Implement → Test → Review → Report)

See [Plue's implementation](https://github.com/evmts/plue/tree/main/workflow/components) for reference.

## What's Included

✅ **Output schemas** - `ralphOutputSchemas` with all standard schemas
✅ **Generic prompts** - UpdateProgress, Discover, IntegrationTest
✅ **Selectors** - Data extraction functions
✅ **Controlled hook** - `useSuperRalph(ctx, { categories, outputs })`
✅ **Ralph orchestration** - Infinite loop with ticket processing
✅ **Compound components** - `<SuperRalph.UpdateProgress />`, `<SuperRalph.Discover />`, etc.

## Selectors

```typescript
import { selectAllTickets } from "@evmts/super-ralph";

const { completed, unfinished } = selectAllTickets(ctx, categories, outputs);
```

Available: `selectAllTickets`, `selectReviewTickets`, `selectDiscoverTickets`, `selectCompletedTicketIds`, `selectProgressSummary`, `selectTicketReport`, `selectResearch`, `selectPlan`, `selectImplement`, `selectTestResults`, `selectSpecReview`, `selectCodeReviews`

## License

MIT
