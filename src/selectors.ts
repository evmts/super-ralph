import type { SmithersCtx } from "smithers-orchestrator";
import type { ralphOutputSchemas } from "./schemas";

/**
 * Generic selectors for Ralph workflow pattern.
 * These can be extended/overridden by specific workflows.
 */

export type RalphOutputs = typeof ralphOutputSchemas;

export interface Ticket {
  id: string;
  title: string;
  description: string;
  category: string;
  priority: "critical" | "high" | "medium" | "low";
  acceptanceCriteria?: string[];
  relevantFiles?: string[];
  referenceFiles?: string[];
}

const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const sortByPriority = (a: Ticket, b: Ticket) => (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3);

export function selectReviewTickets(ctx: SmithersCtx<RalphOutputs>, focuses: ReadonlyArray<{ readonly id: string }>, outputs: RalphOutputs): { tickets: Ticket[]; findings: string | null } {
  const tickets: Ticket[] = [];
  const summaryParts: string[] = [];

  for (const { id } of focuses) {
    const review = ctx.outputMaybe(outputs.category_review, { nodeId: `codebase-review:${id}` });
    if (review?.suggestedTickets) tickets.push(...review.suggestedTickets);
    if (review && review.overallSeverity !== "none") {
      summaryParts.push(`${id} (${review.overallSeverity}): ${review.specCompliance.feedback}`);
    }
  }

  return {
    tickets,
    findings: summaryParts.length > 0 ? summaryParts.join("\n") : null,
  };
}

export function selectDiscoverTickets(ctx: SmithersCtx<RalphOutputs>, outputs: RalphOutputs): Ticket[] {
  const discoverOutput = ctx.outputMaybe(outputs.discover, { nodeId: "discover" });
  return discoverOutput?.tickets ?? [];
}

export function selectCompletedTicketIds(ctx: SmithersCtx<RalphOutputs>, tickets: Ticket[], outputs: RalphOutputs): string[] {
  return tickets
    .filter((t) => {
      const report = ctx.outputMaybe(outputs.report, { nodeId: `${t.id}:report` });
      return report?.status === "complete";
    })
    .map((t) => t.id);
}

export function selectProgressSummary(ctx: SmithersCtx<RalphOutputs>, outputs: RalphOutputs): string | null {
  const progress = ctx.outputMaybe(outputs.progress, { nodeId: "update-progress" });
  return progress?.summary ?? null;
}

export function selectAllTickets(ctx: SmithersCtx<RalphOutputs>, focuses: ReadonlyArray<{ readonly id: string }>, outputs: RalphOutputs): { all: Ticket[]; completed: string[]; unfinished: Ticket[] } {
  const { tickets: reviewTickets } = selectReviewTickets(ctx, focuses, outputs);
  const featureTickets = selectDiscoverTickets(ctx, outputs);

  // Merge and deduplicate tickets (review tickets take priority)
  const seenIds = new Set<string>();
  const all: Ticket[] = [];
  for (const ticket of [...reviewTickets.sort(sortByPriority), ...featureTickets.sort(sortByPriority)]) {
    if (!seenIds.has(ticket.id)) {
      seenIds.add(ticket.id);
      all.push(ticket);
    }
  }

  const completed = selectCompletedTicketIds(ctx, all, outputs);
  const unfinished = all.filter((t) => !completed.includes(t.id));

  return { all, completed, unfinished };
}

export function selectTicketReport(ctx: SmithersCtx<RalphOutputs>, ticketId: string, outputs: RalphOutputs) {
  return ctx.outputMaybe(outputs.report, { nodeId: `${ticketId}:report` });
}

export function selectResearch(ctx: SmithersCtx<RalphOutputs>, ticketId: string, outputs: RalphOutputs) {
  return ctx.outputMaybe(outputs.research, { nodeId: `${ticketId}:research` });
}

export function selectPlan(ctx: SmithersCtx<RalphOutputs>, ticketId: string, outputs: RalphOutputs) {
  return ctx.outputMaybe(outputs.plan, { nodeId: `${ticketId}:plan` });
}

export function selectImplement(ctx: SmithersCtx<RalphOutputs>, ticketId: string, outputs: RalphOutputs) {
  return ctx.outputMaybe(outputs.implement, { nodeId: `${ticketId}:implement` });
}

export function selectTestResults(ctx: SmithersCtx<RalphOutputs>, ticketId: string, outputs: RalphOutputs) {
  return ctx.outputMaybe(outputs.test_results, { nodeId: `${ticketId}:test` });
}

export function selectSpecReview(ctx: SmithersCtx<RalphOutputs>, ticketId: string, outputs: RalphOutputs) {
  return ctx.outputMaybe(outputs.spec_review, { nodeId: `${ticketId}:spec-review` });
}

export function selectCodeReviews(ctx: SmithersCtx<RalphOutputs>, ticketId: string, outputs: RalphOutputs) {
  const claude = ctx.outputMaybe(outputs.code_review, { nodeId: `${ticketId}:code-review` });
  const codex = ctx.outputMaybe(outputs.code_review_codex, { nodeId: `${ticketId}:code-review-codex` });
  const gemini = ctx.outputMaybe(outputs.code_review_gemini, { nodeId: `${ticketId}:code-review-gemini` });

  const severityRank: Record<string, number> = { critical: 3, major: 2, minor: 1, none: 0 };
  const severities = [claude?.severity, codex?.severity, gemini?.severity].filter(Boolean) as string[];
  const worstSeverity = severities.length > 0
    ? severities.reduce((worst, s) => (severityRank[s] ?? 0) > (severityRank[worst] ?? 0) ? s : worst, "none")
    : "none";

  const toArray = (v: unknown): string[] => Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  const mergedIssues = [
    ...toArray(claude?.issues).map((i: string) => `[Claude] ${i}`),
    ...toArray(codex?.issues).map((i: string) => `[Codex] ${i}`),
    ...toArray(gemini?.issues).map((i: string) => `[Gemini] ${i}`),
  ];
  const mergedFeedback = [
    claude?.feedback ? `Claude: ${claude.feedback}` : null,
    codex?.feedback ? `Codex: ${codex.feedback}` : null,
    gemini?.feedback ? `Gemini: ${gemini.feedback}` : null,
  ].filter(Boolean).join("\n\n");

  return {
    claude,
    codex,
    gemini,
    worstSeverity,
    mergedIssues,
    mergedFeedback,
  };
}
