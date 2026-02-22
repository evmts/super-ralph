# Super Ralph Architecture - Smithers Workflow Edition

## Overview

Super Ralph has been refactored to use a full Smithers orchestration architecture where **ALL AI interactions** happen through the Smithers workflow tree. This provides:

- ✅ **Resumability**: Can restart from any step
- ✅ **Observability**: All state persisted in SQLite database
- ✅ **Consistent Coordination**: No more direct agent calls outside the workflow
- ✅ **Real-time Monitoring**: Live web dashboard for workflow progress

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Super Ralph CLI                              │
│  (Generates Smithers Workflow + Executes via Smithers Engine)   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Smithers Workflow Tree                         │
│                                                                  │
│  <Workflow name="super-ralph-full">                             │
│    <Sequence>                                                    │
│      ┌────────────────────────────────────────────┐            │
│      │  1. ClarifyingQuestions                    │            │
│      │     - Generate questions via AI            │            │
│      │     - Launch interactive UI (external)     │            │
│      │     - Collect user answers                 │            │
│      └────────────────────────────────────────────┘            │
│                      ↓                                           │
│      ┌────────────────────────────────────────────┐            │
│      │  2. InterpretConfig                        │            │
│      │     - Convert prompt + answers → config    │            │
│      │     - Use AI for intelligent interpretation│            │
│      └────────────────────────────────────────────┘            │
│                      ↓                                           │
│      ┌────────────────────────────────────────────┐            │
│      │  3. Parallel Execution                     │            │
│      │     ┌────────────────┐  ┌────────────────┐│            │
│      │     │  SuperRalph    │  │  Monitor       ││            │
│      │     │  - Full workflow│  │  - Web UI      ││            │
│      │     │  - Tickets      │  │  - Real-time   ││            │
│      │     │  - Reviews      │  │  - Stats       ││            │
│      │     │  - Landing      │  │  - Events      ││            │
│      │     └────────────────┘  └────────────────┘│            │
│      └────────────────────────────────────────────┘            │
│    </Sequence>                                                  │
│  </Workflow>                                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Smithers Database (SQLite)                     │
│  - All workflow state                                            │
│  - Component outputs (questions, config, reports, etc.)          │
│  - Agent interactions                                            │
│  - Resumable from any point                                      │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. ClarifyingQuestions Component

**Location**: `src/components/ClarifyingQuestions.tsx`

**Purpose**: Generate and collect workflow customization preferences

**Workflow**:
1. **Generate Step** (optional): Use AI to generate 10-15 contextual questions
2. **Collect Step**: Launch external interactive UI process
   - Keyboard-navigable interface
   - Arrow keys, number selection, custom answers
   - Beautiful terminal UI
3. **Output**: Structured session with Q&A and summary

**Output Schema**:
```typescript
{
  questions: ClarificationQuestion[],
  answers: ClarificationAnswer[],
  session: {
    answers: ClarificationAnswer[],
    summary: string
  }
}
```

**Key Innovation**: Uses **external process coordination** instead of Smithers lifecycle callbacks. This allows blocking user input without modifying Smithers core.

### 2. InterpretConfig Component

**Location**: `src/components/InterpretConfig.tsx`

**Purpose**: Convert user prompt + clarifications into SuperRalph configuration

**Workflow**:
1. Takes user prompt
2. Takes clarification session (if available)
3. Uses AI to generate configuration
4. Returns structured SuperRalphCliConfig

**Output Schema**:
```typescript
{
  projectName: string,
  projectId: string,
  focuses: Array<{id: string, name: string}>,
  specsPath: string,
  referenceFiles: string[],
  buildCmds: Record<string, string>,
  testCmds: Record<string, string>,
  preLandChecks: string[],
  postLandChecks: string[],
  codeStyle: string,
  reviewChecklist: string[],
  maxConcurrency: number
}
```

### 3. Monitor Component

**Location**: `src/components/Monitor.tsx`

**Purpose**: Real-time web dashboard for workflow monitoring

**Features**:
- **Auto-port Discovery**: Finds available port (4500-4600)
- **Live Dashboard**:
  - Progress bars (reports, landing)
  - Quick stats
  - Recent activity feed
  - Clarification answers display
- **Auto-refresh**: Every 5 seconds
- **Beautiful UI**: Dark theme with gradient accents

**Access**: Prints URL like `http://localhost:4532` to console

**Output Schema**:
```typescript
{
  serverUrl: string,
  port: number,
  started: boolean
}
```

**Key Innovation**: Runs as a **background task** in parallel with SuperRalph workflow. Uses SQLite database polling for state updates.

## External Coordination

Instead of adding complex lifecycle callbacks to Smithers core, we use **pragmatic external coordination**:

### Interactive UI Process

**Script**: `src/cli/interactive-questions.ts`

**Usage**:
```bash
bun interactive-questions.ts questions.json answers.json
```

**How it works**:
1. ClarifyingQuestions writes questions to temp file
2. Launches this script as child process (blocking)
3. Script shows keyboard UI, collects answers
4. Writes answers to output file
5. ClarifyingQuestions reads answers and continues

**Benefits**:
- ✅ No Smithers core changes needed
- ✅ Clean separation of concerns
- ✅ Works with existing Smithers primitives
- ✅ Easy to test independently

## CLI Workflow

### Entry Point

**Location**: `src/cli/index.ts`

**Responsibilities**:
1. Parse command-line arguments
2. Detect environment (agents, package scripts, jj)
3. Generate Smithers workflow file
4. Execute workflow via Smithers CLI

### Generated Workflow

The CLI generates a complete Smithers workflow TSX file that includes:
- All component imports
- Agent initialization (Claude, Codex)
- Full workflow tree structure
- Configuration constants

**Location**: `.super-ralph/generated/workflow.tsx`

### Execution

```bash
bun -r preload.ts run smithers-cli run workflow.tsx --root . --run-id sr-xxx
```

## Database Schema

All state is persisted in `.super-ralph/workflow.db`:

### Custom Tables (from ralphOutputSchemas)
- `clarifying_questions`: User Q&A session
- `interpret_config`: Generated configuration
- `monitor`: Monitor server state
- `discover`: Discovered tickets
- `research`, `plan`, `implement`, `test_results`, etc.
- `report`: Ticket status reports
- `land`: Merge queue results

### Smithers System Tables
- `_smithers_nodes`: Task execution state
- `_smithers_cache`: Output caching
- `_smithers_events`: Event log
- `_smithers_approvals`: Manual approval tracking

## Usage Examples

### Basic Usage

```bash
cd my-project
super-ralph "Build a React todo app"
```

This will:
1. Ask 12 clarifying questions (keyboard UI)
2. Generate configuration based on answers
3. Launch workflow + monitor
4. Print monitor URL (e.g., `http://localhost:4532`)

### Skip Questions

```bash
super-ralph "Add authentication" --skip-questions
```

Uses default configuration, skips interactive questions.

### Dry Run

```bash
super-ralph "Implement feature X" --dry-run
```

Generates workflow files but doesn't execute.

### Custom Concurrency

```bash
super-ralph "Refactor codebase" --max-concurrency 12
```

Override default concurrency for faster/slower execution.

## Benefits of New Architecture

### 1. Full Resumability

Because everything goes through Smithers:
```bash
# Workflow crashes or stops
bun -r preload.ts run smithers-cli resume workflow.tsx --run-id sr-xxx
```

Resumes from exactly where it stopped, including:
- Partial question completion
- Partial config generation
- In-progress tickets
- Monitor state

### 2. Complete Observability

All AI interactions are in the database:
- Query past questions/answers
- Inspect config decisions
- Trace ticket progression
- Analyze failure patterns

### 3. Consistent Coordination

No more mixing direct agent calls with Smithers orchestration:
- Everything uses Task primitives
- All outputs follow schema contracts
- Dependency tracking works correctly

### 4. Live Monitoring

Monitor component provides real-time insight:
- See progress without polling logs
- Understand bottlenecks visually
- Share dashboard URL with team

## Development

### Adding New Components

1. Create component in `src/components/`
2. Define output schema with Zod
3. Export from `src/components/index.ts`
4. Add schema to `src/schemas.ts` → `ralphOutputSchemas`
5. Create selector in `src/selectors.ts`
6. Export selector from `src/index.ts`

### Testing Components

Components can be tested independently:

```typescript
import { ClarifyingQuestions } from "super-ralph/components";

// In your test workflow
<ClarifyingQuestions
  ctx={ctx}
  outputs={outputs}
  prompt="Test prompt"
  repoRoot="/path/to/repo"
  packageScripts={{}}
  agent={testAgent}
  preGeneratedQuestions={mockQuestions}
/>
```

## Migration from Old CLI

The old CLI has been preserved as `src/cli/index-old.ts` for reference.

Key differences:
- **Old**: Direct agent.generate() calls for questions/config
- **New**: Full Smithers workflow orchestration
- **Old**: No resumability
- **New**: Can resume from any step
- **Old**: Basic terminal output
- **New**: Live web dashboard

## Troubleshooting

### Port Conflicts

If Monitor can't find a port:
- Check for processes using ports 4500-4600
- Monitor will auto-skip used ports

### Interactive UI Issues

If keyboard navigation doesn't work:
- Ensure terminal supports raw mode
- Try running in iTerm2 or native Terminal.app
- Check that `src/cli/interactive-questions.ts` is executable

### Workflow Resume Issues

If resume fails:
- Check database exists: `.super-ralph/workflow.db`
- Verify run ID matches: Look for `sr-xxx` in logs
- Try running from scratch with new run ID

### Agent Detection

If agents aren't detected:
- Verify `claude` or `codex` in PATH: `which claude`
- Install agents: https://claude.ai/download
- Check environment doesn't block agent execution

## Future Enhancements

Potential improvements identified in AGENT_HANDOFF.md:

1. **Full Smithers Lifecycle Callbacks** (if needed in future)
   - `onStart`, `onSuccess`, `onError`, `onFinished`
   - `onPause`, `onResume` for true in-workflow blocking
   - Would allow cleaner component coordination

2. **Enhanced Monitor Features**
   - Ticket add/remove/cancel via UI
   - Workflow pause/resume controls
   - Restart workflow button
   - AI chat in browser (currently planned but not implemented)

3. **Better Question Generation**
   - More contextual analysis
   - Repo-specific question templates
   - Learning from past sessions

4. **Config Templates**
   - Save common configurations
   - Project-type templates (React, Go, Rust, etc.)
   - Team sharing of configurations

## References

- **AGENT_HANDOFF.md**: Original refactoring specification
- **Smithers Docs**: https://github.com/anthropics/smithers
- **Super Ralph**: This repository
