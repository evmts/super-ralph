/**
 * Super Ralph Workflow Clarification Questions
 *
 * This module provides a structured questionnaire for gathering workflow preferences.
 * Can be used by both the CLI and AI agents to customize workflow behavior.
 */

export type ClarificationAnswer = {
  question: string;
  answer: string;
  isCustom: boolean;
};

export type ClarificationSession = {
  answers: ClarificationAnswer[];
  summary: string;
};

export type ClarificationQuestion = {
  question: string;
  choices: Array<{
    label: string;
    description: string;
    value: string;
  }>;
};

/**
 * Generate the standard set of clarifying questions for Super Ralph workflows.
 * These questions help determine workflow behavior, testing strategy, review process, etc.
 */
export function getClarificationQuestions(): ClarificationQuestion[] {
  return [
    {
      question: "What is the primary goal of this workflow?",
      choices: [
        {
          label: "Feature Development",
          description: "Building new features with comprehensive testing and review cycles",
          value: "feature",
        },
        {
          label: "Bug Fixes",
          description: "Fixing existing issues with focused regression testing",
          value: "bugfix",
        },
        {
          label: "Refactoring",
          description: "Code restructuring while maintaining behavior with extensive test coverage",
          value: "refactor",
        },
        {
          label: "Exploration/Research",
          description: "Investigating approaches with lightweight validation and rapid iteration",
          value: "exploration",
        },
      ],
    },
    {
      question: "What level of test coverage is expected?",
      choices: [
        {
          label: "Critical Paths Only",
          description: "Test only the most important user flows and edge cases",
          value: "critical",
        },
        {
          label: "Standard Coverage",
          description: "Test all modified functions and their direct dependencies",
          value: "standard",
        },
        {
          label: "Comprehensive",
          description: "Test all affected code paths including indirect dependencies and integrations",
          value: "comprehensive",
        },
        {
          label: "Minimal",
          description: "Light smoke tests only, prioritize speed over coverage",
          value: "minimal",
        },
      ],
    },
    {
      question: "How should code review be conducted?",
      choices: [
        {
          label: "Strict",
          description: "Multiple review rounds with detailed checklist validation and architectural scrutiny",
          value: "strict",
        },
        {
          label: "Standard",
          description: "Single thorough review focusing on correctness and spec compliance",
          value: "standard",
        },
        {
          label: "Lightweight",
          description: "Quick review for obvious issues and style consistency",
          value: "lightweight",
        },
        {
          label: "Auto-merge",
          description: "Skip manual review if automated checks pass (use with caution)",
          value: "auto",
        },
      ],
    },
    {
      question: "What is your preferred development velocity?",
      choices: [
        {
          label: "Rapid Iteration",
          description: "Fast cycles with higher concurrency, accepting some technical debt for speed",
          value: "rapid",
        },
        {
          label: "Balanced",
          description: "Moderate pace balancing speed with quality and maintainability",
          value: "balanced",
        },
        {
          label: "Deliberate",
          description: "Slower, methodical approach with thorough validation at each step",
          value: "deliberate",
        },
        {
          label: "Maximum Speed",
          description: "Highest concurrency, minimal checks, move fast and fix issues later",
          value: "maximum",
        },
      ],
    },
    {
      question: "How should pre-landing validation work?",
      choices: [
        {
          label: "Full Suite",
          description: "Run all builds, typechecks, lints, and tests before allowing merge",
          value: "full",
        },
        {
          label: "Essential Only",
          description: "Run only critical checks (typecheck + essential tests)",
          value: "essential",
        },
        {
          label: "Typecheck Only",
          description: "Just verify types compile, skip other validations for speed",
          value: "typecheck",
        },
        {
          label: "Skip Validation",
          description: "Trust the implementation, validate post-merge instead",
          value: "skip",
        },
      ],
    },
    {
      question: "What post-landing validation is needed?",
      choices: [
        {
          label: "Full Test Suite",
          description: "Run complete test suite after merge to catch integration issues",
          value: "full-tests",
        },
        {
          label: "Integration Tests",
          description: "Run integration and E2E tests only, skip unit tests",
          value: "integration",
        },
        {
          label: "Smoke Tests",
          description: "Quick validation that critical paths still work",
          value: "smoke",
        },
        {
          label: "None",
          description: "Skip post-merge validation entirely",
          value: "none",
        },
      ],
    },
    {
      question: "How should the workflow handle failures?",
      choices: [
        {
          label: "Retry Aggressively",
          description: "Retry failed tasks up to 5 times with exponential backoff before giving up",
          value: "aggressive",
        },
        {
          label: "Standard Retry",
          description: "Retry failed tasks 2-3 times then surface errors for manual intervention",
          value: "standard",
        },
        {
          label: "Fail Fast",
          description: "Stop immediately on first failure for quick debugging",
          value: "fail-fast",
        },
        {
          label: "Continue on Error",
          description: "Log failures but continue processing other tasks when possible",
          value: "continue",
        },
      ],
    },
    {
      question: "What architectural areas should receive focus?",
      choices: [
        {
          label: "Auto-detect",
          description: "Let the AI analyze the codebase and determine appropriate focus areas",
          value: "auto",
        },
        {
          label: "Frontend Heavy",
          description: "Prioritize UI components, state management, and user interactions",
          value: "frontend",
        },
        {
          label: "Backend Heavy",
          description: "Focus on APIs, data models, business logic, and infrastructure",
          value: "backend",
        },
        {
          label: "Full Stack",
          description: "Balanced attention across all architectural layers",
          value: "fullstack",
        },
      ],
    },
    {
      question: "How should spec compliance be verified?",
      choices: [
        {
          label: "Strict Compliance",
          description: "Block merge if any spec requirement is not fully addressed",
          value: "strict",
        },
        {
          label: "Best Effort",
          description: "Aim for spec compliance but allow pragmatic deviations with justification",
          value: "best-effort",
        },
        {
          label: "Advisory Only",
          description: "Treat specs as guidelines, focus on working software over documentation",
          value: "advisory",
        },
        {
          label: "Interpret Liberally",
          description: "Allow creative interpretation of requirements based on discovered constraints",
          value: "liberal",
        },
      ],
    },
    {
      question: "What documentation updates are required?",
      choices: [
        {
          label: "Comprehensive",
          description: "Update all relevant docs including API references, guides, and inline comments",
          value: "comprehensive",
        },
        {
          label: "API Changes Only",
          description: "Document public API changes and breaking changes only",
          value: "api-only",
        },
        {
          label: "Inline Comments",
          description: "Add code comments for complex logic but skip external documentation",
          value: "inline",
        },
        {
          label: "Self-Documenting",
          description: "Rely on clear code structure and naming, minimize explicit documentation",
          value: "self-documenting",
        },
      ],
    },
    {
      question: "How should the merge queue be prioritized?",
      choices: [
        {
          label: "FIFO (First In, First Out)",
          description: "Process tickets in the order they were completed, ensuring fairness",
          value: "fifo",
        },
        {
          label: "Priority-Based",
          description: "High-priority tickets jump the queue, critical fixes land first",
          value: "priority",
        },
        {
          label: "Risk-Sorted",
          description: "Merge low-risk changes first, batch risky changes together",
          value: "risk",
        },
        {
          label: "Dependency-Aware",
          description: "Merge foundation tickets before dependent work regardless of completion order",
          value: "dependency",
        },
      ],
    },
    {
      question: "What level of speculative execution is acceptable?",
      choices: [
        {
          label: "Conservative (Depth 1-2)",
          description: "Only start obviously safe follow-up work, minimize wasted effort on blocked paths",
          value: "conservative",
        },
        {
          label: "Moderate (Depth 3-4)",
          description: "Speculatively start likely tasks but avoid deep chains of assumptions",
          value: "moderate",
        },
        {
          label: "Aggressive (Depth 5+)",
          description: "Maximize parallelism by starting all plausible work, accept some rollback cost",
          value: "aggressive",
        },
        {
          label: "Disabled",
          description: "No speculation, only work on tasks with all dependencies satisfied",
          value: "disabled",
        },
      ],
    },
  ];
}

/**
 * Build a prompt that AI agents can use to gather workflow clarifications.
 * This provides a structured way for agents to ask the same questions.
 */
export function buildAgentClarificationPrompt(): string {
  const questions = getClarificationQuestions();

  const questionsBlock = questions
    .map((q, i) => {
      const choicesBlock = q.choices
        .map((c, j) => `    ${j + 1}. ${c.label}: ${c.description}`)
        .join("\n");
      return `${i + 1}. ${q.question}\n${choicesBlock}\n    5. Custom: (User provides their own answer)`;
    })
    .join("\n\n");

  return `# Super Ralph Workflow Clarification Questions

You are helping configure a Super Ralph workflow. Ask the user the following questions to gather their preferences.

For each question:
- Present all 5 options clearly with their descriptions
- Accept either a number (1-5) to select a preset, or custom text if they choose option 5
- Record their choice

## Questions to Ask:

${questionsBlock}

## Instructions:
1. Ask each question sequentially (minimum ${questions.length} questions)
2. Present all choices with detailed descriptions
3. Accept the user's choice and record it
4. After all questions are answered, provide a summary
5. Use the answers to inform the workflow configuration with specific settings:
   - Adjust maxConcurrency based on velocity preference (rapid=12-16, balanced=6-8, deliberate=2-4, maximum=24-32)
   - Set taskRetries based on failure handling (aggressive=5, standard=3, fail-fast=1, continue=3)
   - Configure preLandChecks based on validation preference (full=all, essential=typecheck+critical, typecheck=types only, skip=none)
   - Configure postLandChecks based on post-landing preference (full-tests=all, integration=e2e+integration, smoke=smoke only, none=skip)
   - Adjust reviewChecklist based on review rigor (strict=comprehensive, standard=focused, lightweight=minimal, auto=skip)
   - Set maxSpeculativeDepth based on speculation preference (conservative=1-2, moderate=3-4, aggressive=5+, disabled=0)

## Output Format:
After gathering all answers, provide them in this JSON structure:
{
  "answers": [
    {
      "question": "What is the primary goal of this workflow?",
      "answer": "Feature Development: Building new features with comprehensive testing and review cycles",
      "isCustom": false
    }
  ],
  "summary": "1. What is the primary goal of this workflow?\\n   → Feature Development: Building new features with comprehensive testing and review cycles\\n\\n2. What level of test coverage is expected?\\n   → Standard Coverage: Test all modified functions and their direct dependencies..."
}`;
}

/**
 * Format a clarification session as a summary string for use in prompts.
 */
export function formatClarificationSummary(session: ClarificationSession): string {
  return session.summary;
}

/**
 * Parse a clarification session from JSON or return undefined if invalid.
 */
export function parseClarificationSession(json: string): ClarificationSession | undefined {
  try {
    const parsed = JSON.parse(json);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.answers) &&
      typeof parsed.summary === "string"
    ) {
      return parsed as ClarificationSession;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
