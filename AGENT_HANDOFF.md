# Agent Handoff: Refactor Super Ralph CLI to Full Smithers Workflow

## Objective

Refactor the entire super-ralph CLI to be a proper Smithers workflow where ALL AI interactions happen through the Smithers orchestration tree, not direct agent calls.

## Current Architecture (WRONG)

Right now the CLI:
1. Directly calls `agent.generate()` to create clarifying questions
2. Directly calls `agent.generate()` to interpret config
3. Only then generates and runs a Smithers workflow with `<SuperRalph>`

This is bad because we're bypassing Smithers orchestration for critical steps.

## Target Architecture (CORRECT)

The CLI should generate and execute a Smithers workflow that looks like this:

```tsx
<Workflow name="super-ralph-full">
  <Sequence>
    {/* Step 1: Generate and ask clarifying questions */}
    <ClarifyingQuestions
      prompt={userPrompt}
      repoRoot={repoRoot}
      packageScripts={packageScripts}
      // Outputs: { questions: Question[], answers: Answer[], session: ClarificationSession }
    />

    {/* Step 2: Interpret config based on prompt + answers */}
    <InterpretConfig
      prompt={userPrompt}
      clarificationSession={ctx.outputs.ClarifyingQuestions.session}
      repoRoot={repoRoot}
      fallbackConfig={fallbackConfig}
      // Outputs: { config: SuperRalphCliConfig }
    />

    {/* Step 3: Run SuperRalph workflow + Monitor in parallel */}
    <Parallel>
      <SuperRalph
        {...ctx.outputs.InterpretConfig.config}
        focuses={ctx.outputs.InterpretConfig.config.focuses}
        agents={agents}
        // ... all the config
      />

      <Monitor
        dbPath={dbPath}
        runId={runId}
        config={ctx.outputs.InterpretConfig.config}
        clarificationSession={ctx.outputs.ClarifyingQuestions.session}
        prompt={userPrompt}
        // Renders interactive UI on random port
      />
    </Parallel>
  </Sequence>
</Workflow>
```

## Component Specifications

### 1. `<ClarifyingQuestions>` Component

**Purpose:** Generate contextual questions using AI, then interactively ask user via terminal UI

**Implementation:**
- This is a Smithers component that uses the `@smithers/core` primitives
- Internally, it should have a `<Generate>` node that creates the questions
- Then use Smithers callbacks (onSuccess, onFinished, onError) to:
  - Pause the workflow
  - Show the interactive keyboard-navigable UI we built
  - Collect user answers
  - Resume the workflow with answers as output

**Prompt for question generation:**
```
Generate 10-15 clarifying questions specific to: {userPrompt}
Consider repo context: {packageScripts}
Return JSON with questions array, each having 4 choices with label/description/value
```

**Output Schema:**
```typescript
{
  questions: ClarificationQuestion[],
  answers: ClarificationAnswer[],
  session: ClarificationSession
}
```

**Key Challenge:**
- How to pause Smithers workflow for interactive input?
- We may need to add `onPause` / `onResume` callbacks to Smithers
- Or use a polling pattern where component waits for user input file to exist

### 2. `<InterpretConfig>` Component

**Purpose:** Convert user prompt + clarification answers into SuperRalph config

**Implementation:**
- Simple `<Generate>` wrapper with structured output
- Takes prompt + clarificationSession
- Returns SuperRalphCliConfig

**Prompt:**
```
You are a workflow-config assistant for super-ralph.
User request: {prompt}
User clarifications: {clarificationSession.summary}

Convert this into SuperRalph configuration JSON:
{
  projectName, projectId, focuses, specsPath, referenceFiles,
  buildCmds, testCmds, preLandChecks, postLandChecks,
  codeStyle, reviewChecklist, maxConcurrency
}
```

**Output Schema:** `SuperRalphCliConfig`

### 3. `<Monitor>` Component

**Purpose:** Real-time monitoring UI for the running workflow

**Implementation:**
- This is a long-running Smithers component
- On mount, it:
  1. Starts a web server on a random port (e.g., 3000-9000)
  2. Serves an interactive UI (React app or simple HTML)
  3. Polls the Smithers database for updates
  4. Renders workflow state, tickets, progress

**UI Features:**
- **Dashboard View:**
  - Show user's original prompt
  - Show clarification answers
  - Show current workflow config
  - Live ticket status (pending/in-progress/completed)
  - Live reports from SuperRalph nodes
  - Git commit activity

- **Interaction:**
  - Restart workflow button
  - Add new ticket (writes to DB, SuperRalph picks it up)
  - Remove/cancel ticket
  - Pause/resume workflow

- **AI Chat Box:**
  - Standalone Claude chat (NOT through Smithers)
  - Direct `new ClaudeCodeAgent()` instance
  - User can ask questions, get help debugging
  - This is the ONLY exception where we bypass Smithers (so chat isn't blocked)

**Database Schema to Read:**
```sql
- run_id: the current workflow run
- tickets: all tickets with status
- reports: all agent reports
- land: merge queue events
- clarifications: saved Q&A session
- config: workflow config
```

**Tech Stack:**
- Web server: Bun's built-in HTTP server or Express
- Frontend: Can be simple HTML + vanilla JS, or React
- Database: Read from the SQLite DB at dbPath
- Port: Use `Bun.serve()` on random available port
- Show URL: Print to console "Monitor: http://localhost:PORT"

### 4. Smithers Enhancements Needed

**You own Smithers, so add these features:**

1. **Lifecycle Callbacks:**
   ```typescript
   interface ComponentCallbacks {
     onStart?: (ctx: Context) => void | Promise<void>;
     onSuccess?: (ctx: Context, output: any) => void | Promise<void>;
     onError?: (ctx: Context, error: Error) => void | Promise<void>;
     onFinished?: (ctx: Context) => void | Promise<void>;
     onPause?: (ctx: Context) => void | Promise<void>;
     onResume?: (ctx: Context) => void | Promise<void>;
   }
   ```

2. **Interactive Input Support:**
   - Components need ability to pause and wait for external input
   - Consider adding `waitForFile(path)` utility
   - Or `waitForCallback()` pattern

3. **Output Watching:**
   - Components should be able to subscribe to other component outputs
   - `ctx.watch(componentId, callback)`

## Migration Steps

### Step 1: Create Smithers Components
- [ ] Create `src/components/ClarifyingQuestions.tsx`
- [ ] Create `src/components/InterpretConfig.tsx`
- [ ] Create `src/components/Monitor.tsx`
- [ ] Define output schemas for each

### Step 2: Enhance Smithers (if needed)
- [ ] Add lifecycle callbacks (onSuccess, onError, onFinished, etc.)
- [ ] Add interactive input support
- [ ] Test with simple example workflow

### Step 3: Refactor CLI Entry Point
- [ ] Instead of direct agent calls, generate full workflow
- [ ] Render workflow with all components: `<Sequence>` → `<ClarifyingQuestions>` → `<InterpretConfig>` → `<Parallel>` → `<SuperRalph>` + `<Monitor>`
- [ ] Remove direct `agent.generate()` calls
- [ ] Keep keyboard UI code but move to ClarifyingQuestions callback

### Step 4: Build Monitor UI
- [ ] Create web server component
- [ ] Build dashboard HTML/React
- [ ] Add DB polling
- [ ] Add AI chat (direct Claude agent, not Smithers)
- [ ] Add ticket management (add/remove/cancel)
- [ ] Add workflow controls (restart/pause/resume)

### Step 5: Testing
- [ ] Test question generation through Smithers
- [ ] Test interactive keyboard navigation
- [ ] Test config interpretation
- [ ] Test Monitor UI startup
- [ ] Test AI chat in Monitor
- [ ] Test full end-to-end flow

## Key Design Decisions

1. **Why Smithers for everything?**
   - Consistent orchestration
   - Proper dependency tracking
   - Database-backed state
   - Resumability
   - Observability

2. **Why NOT Smithers for Monitor chat?**
   - Chat needs to be responsive even if workflow is blocked
   - Separate concern: debugging assistant vs. workflow execution
   - Direct Claude agent is simpler for chat

3. **Where does keyboard UI code go?**
   - Keep the `promptMultipleChoice()` function
   - Call it from `ClarifyingQuestions` component's onSuccess callback
   - When questions are generated, pause, show UI, collect answers, resume

4. **How to handle workflow generation?**
   - CLI should use `renderWorkflowFile()` pattern
   - Generate a workflow.tsx that imports all components
   - Execute with `smithers run workflow.tsx`

## File Structure

```
src/
├── cli/
│   ├── index.ts              # Entry point, generates workflow
│   ├── clarifications.ts      # Types only, no logic
│   └── ui.ts                  # Keyboard UI functions (promptMultipleChoice)
├── components/
│   ├── SuperRalph.tsx         # Existing
│   ├── ClarifyingQuestions.tsx # NEW
│   ├── InterpretConfig.tsx     # NEW
│   └── Monitor.tsx             # NEW
└── monitor/
    ├── server.ts              # Web server
    ├── ui.html                # Dashboard UI
    └── chat.ts                # Claude chat (non-Smithers)
```

## Expected Behavior

```bash
$ cd todo-test
$ bun ../super-ralph/src/cli/index.ts "Build a React todo app"

Generating workflow...
Starting Super Ralph with Smithers orchestration...

Monitor UI: http://localhost:4532

[Smithers] Running ClarifyingQuestions...
[Smithers] Generating contextual questions...
[Smithers] ✓ Generated 12 questions

# Interactive keyboard UI appears
[Question 1/12] How should React components be structured for this todo app?
→ 1. Single file components
  2. Component + hook separation
  3. Atomic design pattern
  4. Feature-based folders
  5. Custom Answer
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │                                                                               │
  └──────────────────────────────────────────────────────────────────────────────┘

# User answers all questions...

[Smithers] ✓ ClarifyingQuestions complete
[Smithers] Running InterpretConfig...
[Smithers] ✓ Config generated
[Smithers] Running Parallel: SuperRalph + Monitor
[Smithers] - SuperRalph: Planning tickets...
[Smithers] - Monitor: Started on http://localhost:4532

# Workflow continues...
# User can open browser to http://localhost:4532 to see live dashboard
```

## Questions for Implementation

1. **Smithers pause/resume:** Do we need new Smithers primitives, or can we use file-based coordination?
2. **Monitor port:** Random? Configurable? Default 3000?
3. **UI tech:** Simple HTML or full React app?
4. **Chat integration:** Should chat be embedded in Monitor or separate?
5. **Ticket management:** Direct DB writes or API through Smithers?

## Success Criteria

- [ ] All AI calls go through Smithers (except Monitor chat)
- [ ] Workflow is fully resumable (can restart from any step)
- [ ] Interactive UI works within Smithers execution
- [ ] Monitor provides real-time visibility
- [ ] User can interact with workflow via Monitor UI
- [ ] No direct `agent.generate()` calls in CLI code
- [ ] Clean separation: CLI generates workflow, Smithers executes it

---

**Agent:** Please implement this refactoring. You own both super-ralph and smithers-orchestrator, so modify both as needed. Prioritize getting the basic Smithers workflow structure working first, then add Monitor UI features.
