# Super Ralph CLI Clarification Questions

The Super Ralph CLI includes an interactive questionnaire system that helps customize workflow behavior through a series of clarifying questions.

## Features

- **12 comprehensive questions** covering all aspects of workflow configuration
- **Interactive keyboard navigation** - use arrow keys (↑/↓) to select options
- **Multiple choice with detailed descriptions** - each option explains what it does
- **Custom answers** - option to provide your own answer for any question
- **AI-friendly export** - questions can be used by AI agents to gather preferences

## Usage

### CLI Usage

By default, the CLI will ask clarifying questions before generating the workflow:

```bash
super-ralph "Build user authentication system"
```

To skip the questions phase:

```bash
super-ralph "Build user authentication system" --skip-questions
```

### Interactive Experience

1. Each question presents 4 preset options plus a "Custom Answer" option
2. Use arrow keys (↑/↓) to navigate between choices
3. Press Enter to select
4. Or type a number (1-5) to jump to that choice
5. Your answers are saved to `.super-ralph/generated/clarifications.json`

### Questions Covered

1. **Primary Goal** - Feature development, bug fixes, refactoring, or exploration
2. **Test Coverage** - Critical paths only, standard, comprehensive, or minimal
3. **Code Review** - Strict, standard, lightweight, or auto-merge
4. **Development Velocity** - Rapid iteration, balanced, deliberate, or maximum speed
5. **Pre-landing Validation** - Full suite, essential only, typecheck only, or skip
6. **Post-landing Validation** - Full tests, integration tests, smoke tests, or none
7. **Failure Handling** - Retry aggressively, standard retry, fail fast, or continue on error
8. **Architectural Focus** - Auto-detect, frontend heavy, backend heavy, or full stack
9. **Spec Compliance** - Strict, best effort, advisory only, or interpret liberally
10. **Documentation** - Comprehensive, API changes only, inline comments, or self-documenting
11. **Merge Queue Priority** - FIFO, priority-based, risk-sorted, or dependency-aware
12. **Speculative Execution** - Conservative (1-2), moderate (3-4), aggressive (5+), or disabled

## How Answers Affect Configuration

The answers directly influence workflow configuration:

- **Development Velocity** sets `maxConcurrency`:
  - Rapid → 12-16 concurrent tasks
  - Balanced → 6-8 concurrent tasks
  - Deliberate → 2-4 concurrent tasks
  - Maximum → 24-32 concurrent tasks

- **Failure Handling** sets `taskRetries`:
  - Aggressive → 5 retries
  - Standard → 3 retries
  - Fail Fast → 1 retry
  - Continue → 3 retries

- **Pre-landing Validation** configures `preLandChecks`:
  - Full Suite → All builds, typechecks, lints, and tests
  - Essential → Typecheck + critical tests only
  - Typecheck Only → Just type validation
  - Skip → No pre-merge validation

- **Post-landing Validation** configures `postLandChecks`:
  - Full Test Suite → Complete test suite
  - Integration Tests → E2E and integration tests only
  - Smoke Tests → Quick validation only
  - None → Skip post-merge validation

- **Speculative Execution** sets `maxSpeculativeDepth`:
  - Conservative → 1-2 levels
  - Moderate → 3-4 levels
  - Aggressive → 5+ levels
  - Disabled → 0 (no speculation)

## Using in AI Agents

The clarification questions are exported as a reusable module for AI agents:

```typescript
import {
  getClarificationQuestions,
  buildAgentClarificationPrompt,
  type ClarificationSession
} from "super-ralph/cli/clarifications";

// Get the questions
const questions = getClarificationQuestions();

// Get a formatted prompt for AI agents
const prompt = buildAgentClarificationPrompt();

// Parse a saved session
import { parseClarificationSession } from "super-ralph/cli/clarifications";
const session = parseClarificationSession(jsonString);
```

### Agent Prompt

The `buildAgentClarificationPrompt()` function returns a comprehensive prompt that AI agents can use to:

1. Ask all 12 questions sequentially
2. Present options with detailed descriptions
3. Accept numeric choices (1-5) or custom text
4. Record answers in the standard format
5. Apply answers to workflow configuration

## Output Format

Answers are saved in JSON format:

```json
{
  "answers": [
    {
      "question": "What is the primary goal of this workflow?",
      "answer": "Feature Development: Building new features with comprehensive testing and review cycles",
      "isCustom": false
    }
  ],
  "summary": "1. What is the primary goal of this workflow?\n   → Feature Development: Building new features with comprehensive testing and review cycles\n\n2. What level of test coverage is expected?\n   → Standard Coverage: Test all modified functions and their direct dependencies..."
}
```

## Keyboard Navigation

The CLI uses raw terminal mode for intuitive keyboard navigation:

- **↑/↓ Arrow Keys** - Navigate between options
- **Enter** - Select current option
- **1-5 Number Keys** - Jump directly to an option
- **Ctrl+C** - Cancel and exit

Visual feedback:
- Selected option is highlighted in cyan
- Arrow (→) indicates current selection
- Options are cleared between questions for clean experience

## Integration with Workflow Config

The clarification session is passed to the AI interpreter agent (Claude or Codex) along with the prompt. The agent uses both the user's original request AND the clarification answers to generate an optimal SuperRalph configuration.

This ensures that workflow behavior matches user preferences without requiring them to manually configure dozens of options.

## Extending Questions

To add new questions, edit `src/cli/clarifications.ts` and add to the `getClarificationQuestions()` function:

```typescript
{
  question: "Your new question here?",
  choices: [
    {
      label: "Option 1",
      description: "What this option does and when to use it",
      value: "option1",
    },
    {
      label: "Option 2",
      description: "What this option does and when to use it",
      value: "option2",
    },
    // ... more options
  ],
}
```

Remember to update:
1. The question count in docs
2. The AI prompt instructions if needed
3. The configuration mapping logic in `buildInterpreterPrompt()`
