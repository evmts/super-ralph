# super-ralph

> Reusable Ralph workflow - ticket-driven development with multi-agent review loops

Zero boilerplate. Generic prompts included. Just configure and go.

## Installation

```bash
bun add @evmts/super-ralph smithers-orchestrator
```

## Usage

```typescript
import { SuperRalph, useSuperRalph, ralphOutputSchemas } from "@evmts/super-ralph";
import { createSmithers } from "smithers-orchestrator";
import { KimiAgent, GeminiAgent, ClaudeCodeAgent } from "smithers-orchestrator";

// 1. Create Smithers with built-in schemas
const { smithers, outputs } = createSmithers(ralphOutputSchemas, { dbPath: "./workflow.db" });

// 2. Define categories
const categories = [
  { id: "auth", name: "Authentication" },
  { id: "api", name: "API Server" },
] as const;

// 3. Define target
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

// 4. Import your orchestrator components
// These contain your domain-specific logic for:
// - CodebaseReview: Review code per category, suggest tickets
// - TicketPipeline: Research → Plan → Implement → Test → Review → Report
// - IntegrationTest: Run integration tests per category
//
// See https://github.com/evmts/plue/tree/main/workflow/components for reference
import { CodebaseReview } from "./components/CodebaseReview";
import { TicketPipeline } from "./components/TicketPipeline";
import { IntegrationTest } from "./components/IntegrationTest";

// 5. Create workflow
export default smithers((ctx) => {
  const superRalphCtx = useSuperRalph(ctx, { categories, outputs });

  return (
    <SuperRalph
      superRalphCtx={superRalphCtx}
      ctx={ctx}
      promptConfig={{
        projectName: "My Project",
        progressFile: "PROGRESS.md",
        commitMessage: "📝 docs: update progress",
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
      maxConcurrency={12}
      taskRetries={3}
      categories={categories}
      outputs={outputs}
      target={target}
      CodebaseReview={CodebaseReview}
      TicketPipeline={TicketPipeline}
      IntegrationTest={IntegrationTest}
    />
  );
});
```

## API

### Required Props

| Prop | Type | Description |
|------|------|-------------|
| `superRalphCtx` | `SuperRalphContext` | From `useSuperRalph(ctx, { categories, outputs })` |
| `ctx` | `SmithersCtx` | Smithers context (for child components) |
| `promptConfig` | `object` | Prompt configuration (see below) |
| `agents` | `object` | Agent configurations (see below) |
| `maxConcurrency` | `number` | Max parallel tasks |
| `taskRetries` | `number` | Retry count for failed tasks |
| `categories` | `Array<{id, name}>` | Work categories |
| `outputs` | `object` | Smithers output schemas |
| `target` | `object` | Project config (build/test cmds, specs path, etc.) |
| `CodebaseReview` | `Component` | Your codebase review orchestrator |
| `TicketPipeline` | `Component` | Your ticket pipeline orchestrator |
| `IntegrationTest` | `Component` | Your integration test orchestrator |

### Prompt Config

```typescript
{
  projectName: string;      // e.g., "My Project"
  progressFile: string;     // e.g., "PROGRESS.md"
  commitMessage?: string;   // Optional, defaults to "📝 docs: update progress"
}
```

### Agents

```typescript
{
  updateProgress: { agent: Agent, fallback: Agent },
  discover: { agent: Agent, fallback: Agent },
}
```

Where `Agent` is a Smithers agent (ClaudeCodeAgent, KimiAgent, etc.).

### Target

```typescript
{
  id: string;
  name: string;
  buildCmds: Record<string, string>;
  testCmds: Record<string, string>;
  fmtCmds: Record<string, string>;
  specsPath: string;
  codeStyle: string;
  reviewChecklist: string[];
  referenceFiles: string[];
}
```

## What's Included

✅ **Generic prompts** - UpdateProgress and Discover prompts built-in
✅ **Selectors** - Data extraction functions
✅ **Controlled component** - Use `useSuperRalph()` hook
✅ **Ralph orchestration** - Infinite loop with ticket processing
✅ **Zero boilerplate** - No MDX files to create

## Selectors

```typescript
import { selectAllTickets } from "@evmts/super-ralph";

const { completed, unfinished } = selectAllTickets(ctx, categories, outputs);
```

Available: `selectAllTickets`, `selectReviewTickets`, `selectDiscoverTickets`, `selectCompletedTicketIds`, `selectProgressSummary`, `selectTicketReport`, `selectResearch`, `selectPlan`, `selectImplement`, `selectTestResults`, `selectSpecReview`, `selectCodeReviews`

## The Pattern

```
Ralph (infinite loop)
  ├─ UpdateProgress (built-in prompt)
  ├─ CodebaseReview (your component)
  ├─ Discover (built-in prompt)
  ├─ IntegrationTest (your component)
  └─ TicketPipeline × N (your component)
```

## License

MIT
