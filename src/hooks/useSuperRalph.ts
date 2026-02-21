import type { SmithersCtx } from "smithers-orchestrator";
import { selectAllTickets, selectReviewTickets, selectProgressSummary } from "../selectors";

export type SuperRalphContext = {
  ctx: SmithersCtx<any>;
  completedTicketIds: string[];
  unfinishedTickets: any[];
  reviewFindings: string | null;
  progressSummary: string | null;
  focuses: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  outputs: any;
  target: any;
};

export type UseSuperRalphConfig = {
  focuses: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  outputs: any;
  target: any;
};

/**
 * Hook to extract SuperRalph state from SmithersCtx.
 * Use this for controlled component pattern or to access workflow state.
 */
export function useSuperRalph(ctx: SmithersCtx<any>, config: UseSuperRalphConfig): SuperRalphContext {
  const { findings: reviewFindings } = selectReviewTickets(ctx, config.focuses, config.outputs);
  const { completed: completedTicketIds, unfinished: unfinishedTickets } = selectAllTickets(ctx, config.focuses, config.outputs);
  const progressSummary = selectProgressSummary(ctx, config.outputs);

  return {
    ctx,
    completedTicketIds,
    unfinishedTickets,
    reviewFindings,
    progressSummary,
    focuses: config.focuses,
    outputs: config.outputs,
    target: config.target,
  };
}
