# super-ralph

> Reusable Ralph workflow - ticket-driven development with multi-agent review loops

An opinionated [Smithers](https://smithers.sh) workflow. You just provide the specs, this workflow does the rest.

Supports subscriptions.

## Installation

```bash
bun add super-ralph smithers-orchestrator
```

## CLI

`super-ralph` can wrap this workflow directly from a prompt string or prompt file:

```bash
super-ralph "Build a merge queue dashboard with jj-native workflows"
super-ralph ./PROMPT.md
```

What the CLI does:
- Preflight checks for `jj` and gives install/setup instructions if missing
- Auto-detects `claude` and `codex` CLIs on startup
- Runs a first planning pass that interprets your prompt into `SuperRalph` props (focuses, test/build commands, checks, etc.)
- Generates a runnable workflow at `.super-ralph/generated/workflow.tsx`
- Runs Smithers with a built-in OpenTUI monitor
- Emits throttled status reports every 5 minutes from workflow outputs + git history deltas
- Detects error patterns and suggests likely fixes
- If `gh` is installed, prepares issue drafts and prints `gh issue create` commands

Useful options:

```bash
super-ralph ./PROMPT.md --max-concurrency 12 --report-interval-minutes 5
super-ralph ./PROMPT.md --dry-run
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
  KimiAgent,
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
    postLandChecks={["make e2e"]}
    codeStyle="Go: snake_case, Rust: snake_case"
    reviewChecklist={["Spec compliance", "Test coverage", "Security"]}
    maxConcurrency={12}
    agents={{
      planning: new CodexAgent({ model: "gpt-5.3-codex", cwd: process.cwd(), yolo: true }),
      implementation: new ClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() }),
      testing: new ClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() }),
      reviewing: new CodexAgent({ model: "gpt-5.3-codex", cwd: process.cwd(), yolo: true }),
      reporting: new GeminiAgent({ model: "gemini-2.5-pro", cwd: process.cwd(), yolo: true }),
      mergeQueue: new KimiAgent({ model: "kimi-code/kimi-for-coding", cwd: process.cwd(), yolo: true, thinking: true }),
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
  └─ Per Ticket × N (parallel)
     ├─ Phase 1: Development (in worktree, on branch ticket/<id>)
     │  ├─ Research → gather context
     │  ├─ Plan → TDD plan
     │  ├─ ValidationLoop (loops until approved)
     │  │  ├─ Implement → write tests + code
     │  │  ├─ Test → run fast tests (pre-land checks)
     │  │  ├─ BuildVerify → check compilation
     │  │  ├─ SpecReview + CodeReview (parallel)
     │  │  └─ ReviewFix → fix issues
     │  └─ Report → completion summary
     └─ Phase 2: Landing (speculative merge queue)
        └─ Land → speculative rebase stack, parallel post-land CI, eviction + cascade re-test, fast-forward main, push
```

### Real speculative merge queue

Each ticket gets its own jj bookmark (`ticket/<id>`) in a dedicated worktree. Development happens in parallel across tickets, and landing uses a **stateful speculative queue**:

1. Queue order is computed from completed tickets
2. Tickets are speculatively rebased as a stack (`A <- B <- C`)
3. Post-land CI runs in parallel for the speculative window
4. Passing prefix is landed by fast-forwarding `main` to the furthest passing ticket
5. Failed ticket is evicted with context; downstream speculative tickets are re-rebased/re-tested
6. Ticket bookmark/worktree cleanup happens on merge and eviction

This means **no code lands on main without passing reviews AND post-rebase CI on speculative state**.

### Dedicated merge queue agent

`SuperRalph` now supports a dedicated coordinator agent:

```tsx
<SuperRalph
  agents={{
    planning: ...,
    implementation: ...,
    testing: ...,
    reviewing: ...,
    reporting: ...,
    mergeQueue: new KimiAgent({ model: "kimi-code/kimi-for-coding", cwd: process.cwd(), yolo: true, thinking: true }),
  }}
  mergeQueueOrdering="report-complete-fifo"
  maxSpeculativeDepth={3}
  postLandChecks={["make e2e", "bun test tests/integration/"]}
  {...otherProps}
/>
```

### Pre-land vs post-land checks

Configure which CI checks run in each phase:

```tsx
<SuperRalph
  // Fast checks run in the worktree during development (driven by testCmds/buildCmds/testSuites)
  testCmds={{ go: "go test ./...", rust: "cargo test" }}
  buildCmds={{ go: "go build ./..." }}

  // Slow checks run after rebase in the merge queue
  postLandChecks={["make e2e", "bun test tests/integration/"]}
  {...otherProps}
/>
```

If `postLandChecks` is not provided, it falls back to `testCmds`.

### jj-native workflow

All agents use jj commands instead of git:
- `jj describe` + `jj new` instead of `git commit`
- `jj bookmark set ticket/<id>` + `jj git push --bookmark` instead of `git push`
- `jj rebase` for landing instead of `git merge`

Requires a jj-colocated repo (`jj git init --colocate`).

This opinionated workflow is optimized in following ways:

- Observability: multiple reporting steps and lots of data stored in sqlite
- Quality: via CI checks, review loops, and context-engineered research-plan-implement steps
- Planning: Optimizes ralph by in real time generating tickets rather than hardcoding them up front
- Parallelization: All tickets implemented in a JJ Workspace in parallel with branch-per-ticket isolation
- Safe landing: Serialized merge queue with semantic conflict detection and post-rebase CI

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
