import type { SmithersCtx } from "smithers-orchestrator";
import { selectAllTickets, selectReviewTickets, selectProgressSummary } from "../selectors";

export type SuperRalphContext = {
  completedTicketIds: string[];
  unfinishedTickets: any[];
  reviewFindings: string | null;
  progressSummary: string | null;
};

export type UseSuperRalphConfig = {
  categories: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  outputs: any;
};

/**
 * Hook to extract SuperRalph state from SmithersCtx.
 * Use this for controlled component pattern or to access workflow state.
 */
export function useSuperRalph(ctx: SmithersCtx<any>, config: UseSuperRalphConfig): SuperRalphContext {
  const { findings: reviewFindings } = selectReviewTickets(ctx, config.categories, config.outputs);
  const { completed: completedTicketIds, unfinished: unfinishedTickets } = selectAllTickets(ctx, config.categories, config.outputs);
  const progressSummary = selectProgressSummary(ctx, config.outputs);

  return {
    completedTicketIds,
    unfinishedTickets,
    reviewFindings,
    progressSummary,
  };
}
