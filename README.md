# super-ralph

> Reusable Ralph workflow - ticket-driven development with multi-agent review loops

An opinionated [Smithers](https://smithers.sh) workflow. You just provide the specs, this workflow does the rest.

## Installation

```bash
bun add @smithers-orchestrator/super-ralph smithers-orchestrator
```

## Usage

```tsx
import {
  SuperRalph,
  ralphOutputSchemas,
} from "@smithers-orchestrator/super-ralph";
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

## What's Included

- ✅ **13 workflow steps** - UpdateProgress, Discover, CategoryReview, Research, Plan, Implement, Test, BuildVerify, SpecReview, CodeReview, ReviewFix, Report, IntegrationTest
- ✅ **All orchestrators** - TicketPipeline, ValidationLoop, CodebaseReview built-in
- ✅ **Generic prompts** - 13 parameterized MDX prompts
- ✅ **Output schemas** - `ralphOutputSchemas` with all standard schemas
- ✅ **Selectors** - Data extraction utilities
- ✅ **Zero boilerplate** - Just configure 5 agents and provide specs

## Configuration

### Required Props

| Prop                  | Description                                                 |
| --------------------- | ----------------------------------------------------------- |
| `ctx`                 | Smithers context                                            |
| `outputs`             | Smithers output schemas (use `ralphOutputSchemas`)          |
| `focuses`             | Work areas: `[{ id: "auth", name: "Authentication" }, ...]` |
| `target`              | Project config (see below)                                  |
| `maxConcurrency`      | Max parallel tasks                                          |
| `planningAgent`       | Agent for research, planning, discovery                     |
| `implementationAgent` | Agent for implementation and fixes                          |
| `testingAgent`        | Agent for running tests and build verification              |
| `reviewingAgent`      | Agent for code and spec reviews                             |
| `reportingAgent`      | Agent for progress updates and reports                      |

### Target Config

```typescript
{
  id: string;                      // Project ID
  name: string;                    // Display name
  specsPath: string;               // Where specs live (e.g., "docs/specs/")
  referenceFiles: string[];        // Reference docs (e.g., ["docs/reference/"])
  buildCmds: Record<string, string>; // Build commands per language
  testCmds: Record<string, string>;  // Test commands per type
  codeStyle: string;               // Code style rules
  reviewChecklist: string[];       // Review criteria
}
```

### Optional Props

| Prop              | Default                         | Description                             |
| ----------------- | ------------------------------- | --------------------------------------- |
| `taskRetries`     | `3`                             | Retry count for failed tasks            |
| `progressFile`    | `"PROGRESS.md"`                 | Progress file path                      |
| `findingsFile`    | `"docs/test-suite-findings.md"` | Test findings file                      |
| `commitConfig`    | `{}`                            | `{ prefix, mainBranch, emojiPrefixes }` |
| `testSuites`      | From `target.testCmds`          | Custom test suite definitions           |
| `focusTestSuites` | `{}`                            | Test suites per focus area              |
| `focusDirs`       | `{}`                            | Directories per focus for review        |
| `skipPhases`      | `new Set()`                     | Phases to skip                          |
| `children`        | `undefined`                     | Spec MDX files                          |

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

## The Pattern

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

## License

MIT
