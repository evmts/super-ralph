import React from "react";
import { Task } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";
import { z } from "zod";
import type { Ticket } from "../selectors";

// --- Schemas ---

export const ticketAssignmentSchema = z.object({
  ticketId: z.string(),
  priority: z.number().int().min(0).describe("0 = highest priority, higher = lower priority"),
  pipelineStage: z.enum(["research", "plan", "implement", "test", "build_verify", "spec_review", "code_review", "review_fix", "report", "land"]),
  assignedAgentId: z.string().describe("Agent ID from the pool to assign"),
  reason: z.string().describe("Why this ticket+agent pairing was chosen"),
  shouldSkip: z.boolean().describe("Whether to skip this ticket this iteration (e.g. blocked on dependency)"),
});

export const ticketScheduleSchema = z.object({
  assignments: z.array(ticketAssignmentSchema),
  reasoning: z.string().describe("Overall scheduling rationale"),
  rateLimitedAgents: z.array(z.object({
    agentId: z.string(),
    resumeAtMs: z.number().describe("Epoch ms when to resume using this agent"),
  })).describe("Agents the scheduler determines are rate-limited"),
  triggerCodebaseReview: z.boolean().describe("Whether to run codebase category reviews this iteration — set true on the first iteration to audit all focus areas, false once reviews are complete"),
  triggerDiscovery: z.boolean().describe("Whether to trigger ticket discovery this iteration — set true when the active ticket count is low relative to concurrency cap, or when most tickets are near completion"),
  triggerIntegrationTests: z.array(z.string()).describe("Category IDs to run integration tests for this iteration (empty = none)"),
  triggerProgressUpdate: z.boolean().describe("Whether to run a progress update this iteration"),
});

export type TicketAssignment = z.infer<typeof ticketAssignmentSchema>;
export type TicketSchedule = z.infer<typeof ticketScheduleSchema>;

// --- Pipeline stage helper ---

const PIPELINE_STAGES_REVERSE = [
  { output: "land",         nodeId: (id: string) => `${id}:land`,         stage: "landed" },
  { output: "report",       nodeId: (id: string) => `${id}:report`,       stage: "report" },
  { output: "review_fix",   nodeId: (id: string) => `${id}:review-fix`,   stage: "review_fix" },
  { output: "code_review",  nodeId: (id: string) => `${id}:code-review`,  stage: "code_review" },
  { output: "spec_review",  nodeId: (id: string) => `${id}:spec-review`,  stage: "spec_review" },
  { output: "build_verify", nodeId: (id: string) => `${id}:build-verify`, stage: "build_verify" },
  { output: "test_results", nodeId: (id: string) => `${id}:test`,         stage: "test" },
  { output: "implement",    nodeId: (id: string) => `${id}:implement`,    stage: "implement" },
  { output: "plan",         nodeId: (id: string) => `${id}:plan`,         stage: "plan" },
  { output: "research",     nodeId: (id: string) => `${id}:research`,     stage: "research" },
] as const;

export function computePipelineStage(ctx: SmithersCtx<any>, ticketId: string): string {
  for (const entry of PIPELINE_STAGES_REVERSE) {
    if (ctx.outputMaybe(entry.output, { nodeId: entry.nodeId(ticketId) })) {
      return entry.stage;
    }
  }
  return "not_started";
}

// --- Component ---

export type TicketSchedulerTicket = {
  ticket: Ticket;
  pipelineStage: string;
  landed: boolean;
  reportComplete: boolean;
  hasImplementation: boolean;
  hasTestResults: boolean;
  hasReview: boolean;
  evictionContext: string | null;
};

export type TicketSchedulerProps = {
  ctx: SmithersCtx<any>;
  tickets: TicketSchedulerTicket[];
  agentPoolContext: string;
  focuses: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  maxConcurrency: number;
  agent: any;
  output: any;
  completedTicketIds: string[];
  totalDiscoveredTickets: number;
  onSchedule?: (schedule: TicketSchedule) => void;
};

function formatTicketTable(tickets: TicketSchedulerTicket[]): string {
  const header = "| ID | Title | Priority | Pipeline Stage | Has Impl | Has Tests | Has Review | Evicted |";
  const sep    = "|----|-------|----------|----------------|----------|-----------|------------|---------|";
  const rows = tickets.map(({ ticket, pipelineStage, hasImplementation, hasTestResults, hasReview, evictionContext }) =>
    `| ${ticket.id} | ${ticket.title} | ${ticket.priority} | ${pipelineStage} | ${hasImplementation ? "✓" : "✗"} | ${hasTestResults ? "✓" : "✗"} | ${hasReview ? "✓" : "✗"} | ${evictionContext ? "⚠ evicted" : "—"} |`,
  );
  return [header, sep, ...rows].join("\n");
}

function formatFocusAreas(focuses: ReadonlyArray<{ readonly id: string; readonly name: string }>): string {
  return focuses.map((f) => `- ${f.id}: ${f.name}`).join("\n");
}

export function TicketScheduler({
  ctx,
  tickets,
  agentPoolContext,
  focuses,
  maxConcurrency,
  agent,
  output,
  completedTicketIds,
  totalDiscoveredTickets,
  onSchedule,
}: TicketSchedulerProps) {
  const ticketTable = formatTicketTable(tickets);
  const focusBlock = formatFocusAreas(focuses);
  const now = new Date().toISOString();
  const activeTickets = tickets.filter((t) => !t.landed);
  const ticketsInPipeline = activeTickets.filter((t) => t.pipelineStage !== "not_started");

  const prompt = `You are the **orchestrator** for an AI-driven development workflow. Your job is to decide how to fill ${maxConcurrency} concurrency slots this iteration to maximize throughput.

## Current Time
${now}

## Pipeline Summary
- Completed (landed): ${completedTicketIds.length}
- Total discovered: ${totalDiscoveredTickets}
- Active in pipeline: ${ticketsInPipeline.length}
- Concurrency cap: ${maxConcurrency}
- Available slots: ~${Math.max(0, maxConcurrency - ticketsInPipeline.length)}

## Ticket State
${tickets.length === 0 ? "(No unfinished tickets — you MUST set triggerDiscovery=true)" : ticketTable}

${tickets.filter((t) => t.evictionContext).map((t) => `### Eviction context for ${t.ticket.id}\n${t.evictionContext}`).join("\n\n")}

## Agent Pool
${agentPoolContext}

## Focus Areas
${focusBlock}

## Your Decisions

You control the ENTIRE concurrency window. Decide ALL of these:

### 1. Ticket Pipeline Assignments
Assign agents to tickets. Include ALL tickets in the \`assignments\` array.

### 2. Trigger Codebase Review (\`triggerCodebaseReview\`)
Set \`true\` on the first iteration to audit all focus areas. Set \`false\` once reviews have completed — they only need to run once.

### 3. Trigger Discovery (\`triggerDiscovery\`)
Set \`true\` when:
- Active tickets < concurrency cap (we have idle slots)
- Most active tickets are near completion (report/land stage)
- No unfinished tickets exist
- We haven't discovered enough tickets to fill the pipeline

### 4. Integration Tests (\`triggerIntegrationTests\`)
List category IDs (e.g. "cat-11-webhooks") to run integration tests for. Run these when:
- A category's tickets have all been implemented
- You want to validate a category's overall health
- Keep this sparse — don't test every category every iteration

### 5. Progress Update (\`triggerProgressUpdate\`)
Set \`true\` every ~3 iterations, or when significant tickets have landed.

## Scheduling Rules

1. **Resume first**: Tickets further in the pipeline get priority over early-stage tickets. Drive existing work to completion.
   - Stage precedence: report > review_fix > code_review > spec_review > build_verify > test > implement > plan > research > not_started
   - A medium-priority ticket at review stage BEATS a critical ticket at research stage.

2. **Priority matters** (within same pipeline stage): critical > high > medium > low.

3. **Agent matching**: Read each agent's description carefully — they contain specific guidance on when to use each agent. Match based on:
   - Task type (tool-heavy vs read-heavy, orchestration vs implementation)
   - Task difficulty (critical/complex → stronger agents, simple/low-stakes → cheaper agents)
   - Agent strengths and weaknesses described in the pool

4. **Rate limit awareness**: Agents may get rate-limited for hours. When an agent is rate-limited:
   - Do NOT assign it. Include it in \`rateLimitedAgents\` with estimated resume time.
   - RESHUFFLE work to available agents. Promote the next-best agent for each task.
   - If the best agent for a task is unavailable, use the next-best match from the pool.
   - Spread load across all available agents to avoid cascading rate limits.

5. **Dependency awareness**: If ticket B depends on ticket A, skip B until A is further along. Set \`shouldSkip: true\`.

6. **Saturate the window**: Your goal is to have ${maxConcurrency} useful tasks running. If you have fewer tickets than slots, trigger discovery. If you have spare slots after assignment, add integration tests.

7. **Maximize cheap agents**: Prefer the cheapest suitable agent for each task. Only escalate to expensive agents when the task genuinely requires it. This maximizes throughput and minimizes rate limit pressure on premium agents.

## Instructions
Produce a complete execution plan. Include ALL tickets in assignments (mark skipped ones). Set triggerDiscovery/triggerIntegrationTests/triggerProgressUpdate to fill idle slots.`;

  return (
    <Task id="ticket-scheduler" output={output} agent={agent} retries={2}>
      {prompt}
    </Task>
  );
}
