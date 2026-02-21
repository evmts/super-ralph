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

import type { Ticket } from "./selectors";

import { SuperRalph } from "./components/SuperRalph";
import type { SuperRalphProps, SuperRalphConfig, SuperRalphAgents, SuperRalphPrompts } from "./components/SuperRalph";
import { useSuperRalph } from "./hooks/useSuperRalph";
import type { SuperRalphContext, UseSuperRalphConfig } from "./hooks/useSuperRalph";

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

  // Components
  SuperRalph,
};

export type {
  Ticket,
  SuperRalphProps,
  SuperRalphConfig,
  SuperRalphAgents,
  SuperRalphPrompts,
  SuperRalphContext,
  UseSuperRalphConfig,
};
