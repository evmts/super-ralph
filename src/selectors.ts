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

function toStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value.map((v) => String(v).trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return undefined;
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*([-*]|\d+\.)\s+/, "").trim())
      .filter(Boolean);
    return lines.length > 0 ? lines : [text];
  }
  return undefined;
}

function normalizePriority(value: unknown): Ticket["priority"] {
  return value === "critical" || value === "high" || value === "medium" || value === "low"
    ? value
    : "medium";
}

function normalizeTicket(raw: unknown): Ticket | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const id = typeof source.id === "string" ? source.id.trim() : "";
  if (!id) return null;
  return {
    id,
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : id,
    description: typeof source.description === "string" ? source.description : "",
    category: typeof source.category === "string" && source.category.trim() ? source.category.trim() : "general",
    priority: normalizePriority(source.priority),
    acceptanceCriteria: toStringList(source.acceptanceCriteria),
    relevantFiles: toStringList(source.relevantFiles),
    referenceFiles: toStringList(source.referenceFiles),
  };
}

export function selectReviewTickets(ctx: SmithersCtx<RalphOutputs>, focuses: ReadonlyArray<{ readonly id: string }>, outputs: RalphOutputs): { tickets: Ticket[]; findings: string | null } {
  const tickets: Ticket[] = [];
  const summaryParts: string[] = [];

  for (const { id } of focuses) {
    const review = ctx.outputMaybe(outputs.category_review, { nodeId: `codebase-review:${id}` });
    if (Array.isArray(review?.suggestedTickets)) {
      for (const candidate of review.suggestedTickets) {
        const normalized = normalizeTicket(candidate);
        if (normalized) tickets.push(normalized);
      }
    }
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
  if (!Array.isArray(discoverOutput?.tickets)) return [];
  const normalized: Ticket[] = [];
  for (const candidate of discoverOutput.tickets) {
    const ticket = normalizeTicket(candidate);
    if (ticket) normalized.push(ticket);
  }
  return normalized;
}

export function selectCompletedTicketIds(ctx: SmithersCtx<RalphOutputs>, tickets: Ticket[], outputs: RalphOutputs): string[] {
  return tickets
    .filter((t) => {
      const land = selectLand(ctx, t.id, outputs);
      return land?.merged === true;
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
  return ctx.latest("report", `${ticketId}:report`);
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

export function selectLand(ctx: SmithersCtx<RalphOutputs>, ticketId: string, outputs: RalphOutputs) {
  return ctx.latest("land", `${ticketId}:land`);
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

export function selectClarifyingQuestions(ctx: SmithersCtx<RalphOutputs>, outputs: RalphOutputs) {
  return ctx.outputMaybe(outputs.clarifying_questions, { nodeId: "clarifying-questions" });
}

export function selectInterpretConfig(ctx: SmithersCtx<RalphOutputs>, outputs: RalphOutputs) {
  return ctx.outputMaybe(outputs.interpret_config, { nodeId: "interpret-config" });
}

export function selectMonitor(ctx: SmithersCtx<RalphOutputs>, outputs: RalphOutputs) {
  return ctx.outputMaybe(outputs.monitor, { nodeId: "monitor" });
}
