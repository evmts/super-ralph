import type { SmithersCtx } from "smithers-orchestrator";

/**
 * Generic selectors for Ralph workflow pattern.
 * These can be extended/overridden by specific workflows.
 */

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
const sortByPriority = (a: any, b: any) => (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3);

export function selectReviewTickets(ctx: SmithersCtx<any>, focuses: ReadonlyArray<{ readonly id: string }>, outputs: any): { tickets: any[]; findings: string | null } {
  const tickets: Ticket[] = [];
  const summaryParts: string[] = [];

  for (const { id } of focuses) {
    const review = ctx.outputMaybe(outputs.category_review, { nodeId: `codebase-review:${id}` }) as any;
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

export function selectDiscoverTickets(ctx: SmithersCtx<any>, outputs: any): any[] {
  const discoverOutput = ctx.outputMaybe(outputs.discover, { nodeId: "discover" }) as any;
  return discoverOutput?.tickets ?? [];
}

export function selectCompletedTicketIds(ctx: SmithersCtx<any>, tickets: any[], outputs: any): string[] {
  return tickets
    .filter((t) => {
      const report = ctx.outputMaybe(outputs.report, { nodeId: `${t.id}:report` }) as any;
      return report?.status === "complete";
    })
    .map((t) => t.id);
}

export function selectProgressSummary(ctx: SmithersCtx<any>, outputs: any): string | null {
  const progress = ctx.outputMaybe(outputs.progress, { nodeId: "update-progress" }) as any;
  return progress?.summary ?? null;
}

export function selectAllTickets(ctx: SmithersCtx<any>, focuses: ReadonlyArray<{ readonly id: string }>, outputs: any): { all: any[]; completed: string[]; unfinished: any[] } {
  const { tickets: reviewTickets } = selectReviewTickets(ctx, focuses, outputs);
  const featureTickets = selectDiscoverTickets(ctx, outputs);

  // Merge and deduplicate tickets (review tickets take priority)
  const seenIds = new Set<string>();
  const all: any[] = [];
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

export function selectTicketReport(ctx: SmithersCtx<any>, ticketId: string, outputs: any): any {
  return ctx.outputMaybe(outputs.report, { nodeId: `${ticketId}:report` }) as any;
}

export function selectResearch(ctx: SmithersCtx<any>, ticketId: string, outputs: any): any {
  return ctx.outputMaybe(outputs.research, { nodeId: `${ticketId}:research` }) as any;
}

export function selectPlan(ctx: SmithersCtx<any>, ticketId: string, outputs: any): any {
  return ctx.outputMaybe(outputs.plan, { nodeId: `${ticketId}:plan` }) as any;
}

export function selectImplement(ctx: SmithersCtx<any>, ticketId: string, outputs: any): any {
  return ctx.outputMaybe(outputs.implement, { nodeId: `${ticketId}:implement` }) as any;
}

export function selectTestResults(ctx: SmithersCtx<any>, ticketId: string, outputs: any): any {
  return ctx.outputMaybe(outputs.test_results, { nodeId: `${ticketId}:test` }) as any;
}

export function selectSpecReview(ctx: SmithersCtx<any>, ticketId: string, outputs: any): any {
  return ctx.outputMaybe(outputs.spec_review, { nodeId: `${ticketId}:spec-review` }) as any;
}

export function selectCodeReviews(ctx: SmithersCtx<any>, ticketId: string, outputs: any) {
  const claude = ctx.outputMaybe(outputs.code_review, { nodeId: `${ticketId}:code-review` }) as any;
  const codex = ctx.outputMaybe(outputs.code_review_codex, { nodeId: `${ticketId}:code-review-codex` }) as any;
  const gemini = ctx.outputMaybe(outputs.code_review_gemini, { nodeId: `${ticketId}:code-review-gemini` }) as any;

  const severityRank: Record<string, number> = { critical: 3, major: 2, minor: 1, none: 0 };
  const severities = [claude?.severity, codex?.severity, gemini?.severity].filter(Boolean);
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
