import type { SmithersCtx } from "smithers-orchestrator";
import type { ralphOutputSchemas } from "./schemas";

/**
 * Generic selectors for Ralph workflow pattern.
 * These can be extended/overridden by specific workflows.
 */

export type RalphOutputs = typeof ralphOutputSchemas;
export type SchemaKey = keyof RalphOutputs & string;

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

// Type helper for output inference
type OutputType<K extends SchemaKey> = ReturnType<SmithersCtx<RalphOutputs>["outputMaybe"]> extends infer R 
  ? R 
  : unknown;

export function selectReviewTickets(
  ctx: SmithersCtx<RalphOutputs>, 
  focuses: ReadonlyArray<{ readonly id: string }>
): { tickets: Ticket[]; findings: string | null } {
  const tickets: Ticket[] = [];
  const summaryParts: string[] = [];

  for (const { id } of focuses) {
    const review = ctx.latest("category_review", `codebase-review:${id}`);
    if (review && Array.isArray((review as any).suggestedTickets)) {
      for (const candidate of (review as any).suggestedTickets) {
        const normalized = normalizeTicket(candidate);
        if (normalized) tickets.push(normalized);
      }
    }
    if (review && (review as any).overallSeverity !== "none") {
      summaryParts.push(`${id} (${(review as any).overallSeverity}): ${(review as any).specCompliance?.feedback}`);
    }
  }

  return {
    tickets,
    findings: summaryParts.length > 0 ? summaryParts.join("\n") : null,
  };
}

export function selectDiscoverTickets(ctx: SmithersCtx<RalphOutputs>): Ticket[] {
  const discoverOutput = ctx.latest("discover", "discover");
  if (!discoverOutput || !Array.isArray((discoverOutput as any).tickets)) return [];
  const normalized: Ticket[] = [];
  for (const candidate of (discoverOutput as any).tickets) {
    const ticket = normalizeTicket(candidate);
    if (ticket) normalized.push(ticket);
  }
  return normalized;
}

export function selectCompletedTicketIds(ctx: SmithersCtx<RalphOutputs>, tickets: Ticket[]): string[] {
  return tickets
    .filter((t) => {
      const land = selectLand(ctx, t.id);
      return land?.merged === true;
    })
    .map((t) => t.id);
}

export function selectProgressSummary(ctx: SmithersCtx<RalphOutputs>): string | null {
  const progress = ctx.latest("progress", "update-progress");
  return (progress as any)?.summary ?? null;
}

export function selectAllTickets(
  ctx: SmithersCtx<RalphOutputs>, 
  focuses: ReadonlyArray<{ readonly id: string }>
): { all: Ticket[]; completed: string[]; unfinished: Ticket[] } {
  const { tickets: reviewTickets } = selectReviewTickets(ctx, focuses);
  const featureTickets = selectDiscoverTickets(ctx);

  // Merge and deduplicate tickets (review tickets take priority)
  const seenIds = new Set<string>();
  const all: Ticket[] = [];
  for (const ticket of [...reviewTickets.sort(sortByPriority), ...featureTickets.sort(sortByPriority)]) {
    if (!seenIds.has(ticket.id)) {
      seenIds.add(ticket.id);
      all.push(ticket);
    }
  }

  const completed = selectCompletedTicketIds(ctx, all);
  const unfinished = all.filter((t) => !completed.includes(t.id));

  return { all, completed, unfinished };
}

export function selectTicketReport(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  return ctx.latest("report", `${ticketId}:report`);
}

export function selectResearch(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  return ctx.latest("research", `${ticketId}:research`) as 
    | { contextFilePath: string; summary: string }
    | undefined;
}

export function selectPlan(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  return ctx.latest("plan", `${ticketId}:plan`) as
    | { planFilePath: string; implementationSteps: string[] | null }
    | undefined;
}

export function selectImplement(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  return ctx.latest("implement", `${ticketId}:implement`) as
    | { whatWasDone: string; filesCreated: string[] | null; filesModified: string[] | null; nextSteps: string | null }
    | undefined;
}

export function selectTestResults(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  return ctx.latest("test_results", `${ticketId}:test`) as
    | { goTestsPassed: boolean; rustTestsPassed: boolean; e2eTestsPassed: boolean; sqlcGenPassed: boolean; failingSummary: string | null }
    | undefined;
}

export function selectSpecReview(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  return ctx.latest("spec_review", `${ticketId}:spec-review`) as
    | { severity: "none" | "minor" | "major" | "critical"; feedback: string; issues: string[] | null }
    | undefined;
}

export function selectLand(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  return ctx.latest("land", `${ticketId}:land`) as
    | { merged: boolean; mergeCommit: string | null; ciPassed: boolean; summary: string; evicted?: boolean; evictionReason?: string | null; evictionDetails?: string | null; attemptedLog?: string | null; attemptedDiffSummary?: string | null; landedOnMainSinceBranch?: string | null }
    | undefined;
}

export function selectCodeReviews(ctx: SmithersCtx<RalphOutputs>, ticketId: string) {
  const claude = ctx.latest("code_review", `${ticketId}:code-review`) as
    | { severity: string; feedback: string; issues: string[] | null }
    | undefined;
  const codex = ctx.latest("code_review_codex", `${ticketId}:code-review-codex`) as
    | { severity: string; feedback: string; issues: string[] | null }
    | undefined;
  const gemini = ctx.latest("code_review_gemini", `${ticketId}:code-review-gemini`) as
    | { severity: string; feedback: string; issues: string[] | null }
    | undefined;

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

export function selectClarifyingQuestions(ctx: SmithersCtx<RalphOutputs>) {
  return ctx.latest("clarifying_questions", "clarifying-questions");
}

export function selectInterpretConfig(ctx: SmithersCtx<RalphOutputs>) {
  return ctx.latest("interpret_config", "interpret-config");
}

export function selectMonitor(ctx: SmithersCtx<RalphOutputs>) {
  return ctx.latest("monitor", "monitor");
}

export function selectTicketPipelineStage(ctx: SmithersCtx<RalphOutputs>, ticketId: string): string {
  const land = ctx.latest("land", `${ticketId}:land`);
  if ((land as any)?.merged) return "landed";
  if (ctx.latest("report", `${ticketId}:report`)) return "report";
  if (ctx.latest("review_fix", `${ticketId}:review-fix`)) return "review_fix";
  if (ctx.latest("code_review", `${ticketId}:code-review`)) return "code_review";
  if (ctx.latest("spec_review", `${ticketId}:spec-review`)) return "spec_review";
  if (ctx.latest("build_verify", `${ticketId}:build-verify`)) return "build_verify";
  if (ctx.latest("test_results", `${ticketId}:test`)) return "test";
  if (ctx.latest("implement", `${ticketId}:implement`)) return "implement";
  if (ctx.latest("plan", `${ticketId}:plan`)) return "plan";
  if (ctx.latest("research", `${ticketId}:research`)) return "research";
  return "not_started";
}
