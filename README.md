# super-ralph

> Reusable Ralph workflow - ticket-driven development with multi-agent review loops

An opinionated [Smithers](https://smithers.sh) workflow. You just provide the specs, this workflow does the rest.

Supports subscriptions.

## Installation

```bash
bun add super-ralph smithers-orchestrator
```

## Usage

```tsx
import {
  SuperRalph,
  ralphOutputSchemas,
} from "super-ralph";
import {
  createSmithers,
  ClaudeCodeAgent,
  CodexAgent,
  GeminiAgent,
} from "smithers-orchestrator";
import PRD from "./specs/PRD.mdx";
import EngineeringSpec from "./specs/Engineering.mdx";

const { smithers, outputs } = createSmithers(ralphOutputSchemas, {
  dbPath: "./workflow.db",
});

export default smithers((ctx) => (
  <SuperRalph
    ctx={ctx}
    outputs={outputs}
    focuses={[
      { id: "auth", name: "Authentication" },
      { id: "api", name: "API Server" },
    ]}
    projectId="my-project"
    projectName="My Project"
    specsPath="docs/specs/"
    referenceFiles={["docs/reference/"]}
    buildCmds={{ go: "go build ./...", rust: "cargo build" }}
    testCmds={{ go: "go test ./...", rust: "cargo test" }}
    codeStyle="Go: snake_case, Rust: snake_case"
    reviewChecklist={["Spec compliance", "Test coverage", "Security"]}
    maxConcurrency={12}
    agents={{
      planning: new CodexAgent({ model: "gpt-5.3-codex", cwd: process.cwd(), yolo: true }),
      implementation: new ClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() }),
      testing: new ClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() }),
      reviewing: new CodexAgent({ model: "gpt-5.3-codex", cwd: process.cwd(), yolo: true }),
      reporting: new GeminiAgent({ model: "gemini-2.5-pro", cwd: process.cwd(), yolo: true }),
    }}
  >
    <PRD />
    <EngineeringSpec />
  </SuperRalph>
));
```

That's it! 30 lines of configuration for a complete workflow.

## The Pattern

Under the hood this opinionated workflow is the following steps all in parallel in a pipeline

```
Ralph (infinite loop)
  ├─ UpdateProgress → PROGRESS.md
  ├─ CodebaseReview → per-focus reviews → tickets
  ├─ Discover → new feature tickets
  ├─ IntegrationTest → per-focus test runs
  └─ TicketPipeline × N (parallel, in worktrees)
     ├─ Research → gather context
     ├─ Plan → TDD plan
     ├─ ValidationLoop (loops until approved)
     │  ├─ Implement → write tests + code
     │  ├─ Test → run all tests
     │  ├─ BuildVerify → check compilation
     │  ├─ SpecReview + CodeReview (parallel)
     │  └─ ReviewFix → fix issues
     └─ Report → completion summary
```

This opinionated workflow is optimized in following ways:

- Observability: multiple reporting steps and lots of data stored in sqlite
- Quality: via CI checks, review loops, and context-engineered research-plan-implement steps
- Planning: Optimizes ralph by in real time generating tickets rather than hardcoding them up front
- Parallelization: All tickets implemented in a JJ Workspace in parallel and then merged back into the main branch as stacked changes

## Advanced: Custom Components

Override any step with a custom component:

```tsx
<SuperRalph
  {...props}
  discover={<MyCustomDiscover agent={...} />}
/>
```

Or run additional logic in parallel:

```tsx
<SuperRalph
  {...props}
  discover={
    <Parallel>
      <SuperRalph.Discover agent={...} specsPath="..." referenceFiles={[...]} />
      <MyAdditionalDiscovery agent={...} />
    </Parallel>
  }
/>
```

These steps default to <SuperRalph.Component when not provided.

## License

MIT
