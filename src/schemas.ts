import { z } from "zod";
import { clarifyingQuestionsOutputSchema } from "./components/ClarifyingQuestions";
import { interpretConfigOutputSchema } from "./components/InterpretConfig";
import { monitorOutputSchema } from "./components/Monitor";

/**
 * Standard output schemas for Ralph workflow pattern.
 * Use these or extend them for your project.
 */

const discoverTicketSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  priority: z.enum(["critical", "high", "medium", "low"]),
  acceptanceCriteria: z.array(z.string()).nullable().optional(),
  relevantFiles: z.array(z.string()).nullable().optional(),
  referenceFiles: z.array(z.string()).nullable().optional(),
});

export const ralphOutputSchemas = {
  clarifying_questions: clarifyingQuestionsOutputSchema,
  interpret_config: interpretConfigOutputSchema,
  monitor: monitorOutputSchema,

  progress: z.object({
    progressFilePath: z.string().nullable(),
    summary: z.string(),
    ticketsCompleted: z.array(z.string()).nullable(),
    ticketsRemaining: z.array(z.string()).nullable(),
  }),

  discover: z.object({
    tickets: z.array(discoverTicketSchema),
    reasoning: z.string(),
    completionEstimate: z.string(),
  }),

  category_review: z.object({
    categoryId: z.string(),
    categoryName: z.string(),
    specCompliance: z.object({
      issues: z.array(z.string()).nullable(),
      severity: z.enum(["none", "minor", "major", "critical"]),
      feedback: z.string(),
    }),
    architectureAlignment: z.object({
      issues: z.array(z.string()).nullable(),
      severity: z.enum(["none", "minor", "major", "critical"]),
      feedback: z.string(),
    }).optional(),
    testCoverage: z.object({
      issues: z.array(z.string()).nullable(),
      severity: z.enum(["none", "minor", "major", "critical"]),
      feedback: z.string(),
    }).optional(),
    codeQuality: z.object({
      issues: z.array(z.string()).nullable(),
      severity: z.enum(["none", "minor", "major", "critical"]),
      feedback: z.string(),
    }),
    testing: z.object({
      issues: z.array(z.string()).nullable(),
      severity: z.enum(["none", "minor", "major", "critical"]),
      feedback: z.string(),
    }),
    jjNativeCompliance: z.object({
      issues: z.array(z.string()).nullable(),
      severity: z.enum(["none", "minor", "major", "critical"]),
      feedback: z.string(),
    }).optional(),
    overallSeverity: z.enum(["none", "minor", "major", "critical"]),
    suggestedTickets: z.array(z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      category: z.string(),
      priority: z.enum(["critical", "high", "medium", "low"]),
    })),
  }),

  research: z.object({
    contextFilePath: z.string(),
    summary: z.string(),
  }),

  plan: z.object({
    planFilePath: z.string(),
    implementationSteps: z.array(z.string()).nullable(),
  }),

  implement: z.object({
    whatWasDone: z.string(),
    filesCreated: z.array(z.string()).nullable(),
    filesModified: z.array(z.string()).nullable(),
    nextSteps: z.string().nullable(),
  }),

  test_results: z.object({
    goTestsPassed: z.boolean(),
    rustTestsPassed: z.boolean(),
    e2eTestsPassed: z.boolean(),
    sqlcGenPassed: z.boolean(),
    failingSummary: z.string().nullable(),
  }),

  build_verify: z.object({
    buildPassed: z.boolean(),
    errors: z.array(z.string()).nullable(),
  }),

  spec_review: z.object({
    severity: z.enum(["none", "minor", "major", "critical"]),
    feedback: z.string(),
    issues: z.array(z.string()).nullable(),
  }),

  code_review: z.object({
    severity: z.enum(["none", "minor", "major", "critical"]),
    feedback: z.string(),
    issues: z.array(z.string()).nullable(),
  }),

  code_review_codex: z.object({
    severity: z.enum(["none", "minor", "major", "critical"]),
    feedback: z.string(),
    issues: z.array(z.string()).nullable(),
  }),

  code_review_gemini: z.object({
    severity: z.enum(["none", "minor", "major", "critical"]),
    feedback: z.string(),
    issues: z.array(z.string()).nullable(),
  }),

  review_fix: z.object({
    allIssuesResolved: z.boolean(),
    summary: z.string(),
  }),

  report: z.object({
    ticketId: z.string(),
    status: z.enum(["partial", "complete", "blocked"]),
    summary: z.string(),
    filesChanged: z.array(z.string()).nullable(),
    testsAdded: z.array(z.string()).nullable(),
    reviewRounds: z.number(),
    struggles: z.array(z.string()).nullable(),
    lessonsLearned: z.array(z.string()).nullable(),
  }),

  integration_test: z.object({
    categoryId: z.string(),
    status: z.enum(["not_setup", "blocked", "partial", "running", "passing"]),
    summary: z.string(),
    blockers: z.array(z.string()).nullable(),
    needsHumanIntervention: z.array(z.string()).nullable(),
    suggestedTickets: z.array(z.string()).nullable(),
  }),

  land: z.object({
    merged: z.boolean(),
    mergeCommit: z.string().nullable(),
    ciPassed: z.boolean(),
    summary: z.string(),
    evicted: z.boolean().default(false),
    evictionReason: z.string().nullable().optional(),
    evictionDetails: z.string().nullable().optional(),
    attemptedLog: z.string().nullable().optional(),
    attemptedDiffSummary: z.string().nullable().optional(),
    landedOnMainSinceBranch: z.string().nullable().optional(),
  }),
};
