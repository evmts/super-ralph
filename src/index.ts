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
} from "./selectors";

import type { Ticket, RalphOutputs } from "./selectors";

import { SuperRalph } from "./components";
import type { SuperRalphProps } from "./components/SuperRalph";
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

  // Hooks
  useSuperRalph,

  // Main Component
  SuperRalph,

  // Schemas
  ralphOutputSchemas,
};

export type {
  Ticket,
  RalphOutputs,
  SuperRalphProps,
  SuperRalphContext,
  UseSuperRalphConfig,
};
