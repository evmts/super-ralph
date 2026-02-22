/**
 * Super Ralph - Reusable Ralph workflow pattern
 *
 * Encapsulates the ticket-driven development workflow with:
 * - Multi-agent code review
 * - TDD validation loops
 * - Automated ticket discovery and prioritization
 * - Stacked ticket processing with worktrees
 *
 * Extracted from Plue workflow, generalized for reuse.
 */

import {
  selectAllTickets,
  selectReviewTickets,
  selectDiscoverTickets,
  selectCompletedTicketIds,
  selectProgressSummary,
  selectTicketReport,
  selectResearch,
  selectPlan,
  selectImplement,
  selectTestResults,
  selectSpecReview,
  selectCodeReviews,
  selectClarifyingQuestions,
  selectInterpretConfig,
  selectMonitor,
} from "./selectors";

import type { Ticket, RalphOutputs } from "./selectors";

import {
  SuperRalph,
  ClarifyingQuestions,
  InterpretConfig,
  Monitor,
  clarifyingQuestionsOutputSchema,
  interpretConfigOutputSchema,
  monitorOutputSchema,
} from "./components";
import type { SuperRalphProps } from "./components/SuperRalph";
import type { ClarifyingQuestionsOutput, ClarifyingQuestionsProps } from "./components/ClarifyingQuestions";
import type { InterpretConfigOutput, InterpretConfigProps } from "./components/InterpretConfig";
import type { MonitorOutput, MonitorProps } from "./components/Monitor";
import { useSuperRalph } from "./hooks/useSuperRalph";
import type { SuperRalphContext, UseSuperRalphConfig } from "./hooks/useSuperRalph";
import { ralphOutputSchemas } from "./schemas";

export {
  // Selectors
  selectAllTickets,
  selectReviewTickets,
  selectDiscoverTickets,
  selectCompletedTicketIds,
  selectProgressSummary,
  selectTicketReport,
  selectResearch,
  selectPlan,
  selectImplement,
  selectTestResults,
  selectSpecReview,
  selectCodeReviews,
  selectClarifyingQuestions,
  selectInterpretConfig,
  selectMonitor,

  // Hooks
  useSuperRalph,

  // Components
  SuperRalph,
  ClarifyingQuestions,
  InterpretConfig,
  Monitor,

  // Schemas
  ralphOutputSchemas,
  clarifyingQuestionsOutputSchema,
  interpretConfigOutputSchema,
  monitorOutputSchema,
};

export type {
  Ticket,
  RalphOutputs,
  SuperRalphProps,
  SuperRalphContext,
  UseSuperRalphConfig,
  ClarifyingQuestionsOutput,
  ClarifyingQuestionsProps,
  InterpretConfigOutput,
  InterpretConfigProps,
  MonitorOutput,
  MonitorProps,
};
