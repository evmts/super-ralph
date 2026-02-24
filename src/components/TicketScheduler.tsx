import React from "react";
import { Task } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";
import { z } from "zod";
import type { Ticket } from "../selectors";
import type { ScheduledJob } from "../scheduledTasks";

// --- Schemas ---

const JOB_TYPES = [
  "discovery",
  "progress-update",
  "codebase-review",
  "integration-test",
  "ticket:research",
  "ticket:plan",
  "ticket:implement",
  "ticket:test",
  "ticket:build-verify",
  "ticket:spec-review",
  "ticket:code-review",
  "ticket:review-fix",
  "ticket:report",
] as const;

export const scheduledJobSchema = z.object({
  jobId: z.string().describe("Stable unique ID (e.g. 'T-1:research', 'discovery', 'codebase-review:cat-5')"),
  jobType: z.enum(JOB_TYPES).describe("Type of job to schedule"),
  agentId: z.string().describe("Agent ID from the pool to assign"),
  ticketId: z.string().nullable().describe("Ticket ID for ticket pipeline jobs, null for global jobs"),
  focusId: z.string().nullable().describe("Focus/category ID for codebase-review and integration-test jobs, null otherwise"),
  reason: z.string().describe("Brief reason for scheduling this job with this agent"),
});

export const ticketScheduleSchema = z.object({
  jobs: z.array(scheduledJobSchema).describe("Flat list of jobs to enqueue — each occupies one concurrency slot"),
  reasoning: z.string().describe("Overall scheduling rationale"),
  rateLimitedAgents: z.array(z.object({
    agentId: z.string(),
    resumeAtMs: z.number().describe("Epoch ms when to resume using this agent"),
  })).describe("Agents the scheduler determines are rate-limited"),
});

export type TicketScheduleJob = z.infer<typeof scheduledJobSchema>;
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

/** Map from jobType to the Smithers output key used to detect completion */
export const JOB_TYPE_TO_OUTPUT_KEY: Record<string, string> = {
  "discovery": "discover",
  "progress-update": "progress",
  "codebase-review": "category_review",
  "integration-test": "integration_test",
  "ticket:research": "research",
  "ticket:plan": "plan",
  "ticket:implement": "implement",
  "ticket:test": "test_results",
  "ticket:build-verify": "build_verify",
  "ticket:spec-review": "spec_review",
  "ticket:code-review": "code_review",
  "ticket:review-fix": "review_fix",
  "ticket:report": "report",
};

/** Check if a scheduled job has already completed (output exists in Smithers) */
export function isJobComplete(ctx: SmithersCtx<any>, job: ScheduledJob): boolean {
  const outputKey = JOB_TYPE_TO_OUTPUT_KEY[job.jobType];
  if (!outputKey) return false;
  return !!ctx.outputMaybe(outputKey, { nodeId: job.jobId });
}

// --- Component ---

export type TicketState = {
  ticket: Ticket;
  pipelineStage: string;
  landed: boolean;
  reportComplete: boolean;
};

export type TicketSchedulerProps = {
  ctx: SmithersCtx<any>;
  ticketStates: TicketState[];
  activeJobs: ScheduledJob[];
  agentPoolContext: string;
  focuses: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  maxConcurrency: number;
  agent: any;
  output: any;
  completedTicketIds: string[];
};

function formatTicketTable(tickets: TicketState[]): string {
  const header = "| ID | Title | Priority | Pipeline Stage | Landed | Report Done |";
  const sep    = "|----|-------|----------|----------------|--------|-------------|";
  const rows = tickets.map(({ ticket, pipelineStage, landed, reportComplete }) =>
    `| ${ticket.id} | ${ticket.title} | ${ticket.priority} | ${pipelineStage} | ${landed ? "✓" : "✗"} | ${reportComplete ? "✓" : "✗"} |`,
  );
  return [header, sep, ...rows].join("\n");
}

function formatActiveJobs(jobs: ScheduledJob[]): string {
  if (jobs.length === 0) return "(no active jobs)";
  const header = "| Job ID | Type | Agent | Ticket | Running Since |";
  const sep    = "|--------|------|-------|--------|---------------|";
  const rows = jobs.map(j => {
    const age = Math.round((Date.now() - j.createdAtMs) / 60_000);
    return `| ${j.jobId} | ${j.jobType} | ${j.agentId} | ${j.ticketId ?? "—"} | ${age}m ago |`;
  });
  return [header, sep, ...rows].join("\n");
}

export function TicketScheduler({
  ctx,
  ticketStates,
  activeJobs,
  agentPoolContext,
  focuses,
  maxConcurrency,
  agent,
  output,
  completedTicketIds,
}: TicketSchedulerProps) {
  const ticketTable = formatTicketTable(ticketStates);
  const activeJobsTable = formatActiveJobs(activeJobs);
  const focusBlock = focuses.map(f => `- ${f.id}: ${f.name}`).join("\n");
  const now = new Date().toISOString();
  const freeSlots = Math.max(0, maxConcurrency - activeJobs.length);
  const activeTickets = ticketStates.filter(t => !t.landed);

  const prompt = `You are the **scheduler** for an AI-driven development workflow. You have ${freeSlots} free concurrency slots to fill with jobs.

## Current Time
${now}

## Pipeline Summary
- Completed (landed): ${completedTicketIds.length}
- Active tickets: ${activeTickets.length}
- Concurrency cap: ${maxConcurrency}
- Currently running jobs: ${activeJobs.length}
- Free slots to fill: ${freeSlots}

## Currently Running Jobs
${activeJobsTable}

## Ticket State
${ticketStates.length === 0 ? "(No tickets — schedule a 'discovery' job)" : ticketTable}

## Agent Pool
${agentPoolContext}

## Focus Areas
${focusBlock}

## Job Types You Can Schedule

### Ticket pipeline jobs (require ticketId, focusId=null)
Each ticket progresses through: research → plan → implement → test → build-verify → spec-review → code-review → review-fix → report
- \`ticket:research\` — Research the ticket's domain and relevant code
- \`ticket:plan\` — Create implementation plan (requires research done)
- \`ticket:implement\` — Write code (requires plan done)
- \`ticket:test\` — Run tests (requires implementation done)
- \`ticket:build-verify\` — Verify build passes (requires implementation done)
- \`ticket:spec-review\` — Review against specs (requires implementation done)
- \`ticket:code-review\` — Code quality review (requires implementation done)
- \`ticket:review-fix\` — Fix review issues (requires reviews done with issues)
- \`ticket:report\` — Final status report (requires all above done)

**Schedule the NEXT stage for each ticket based on its current pipeline stage.** Don't schedule a stage that's already complete or whose prerequisites aren't met.

### Global jobs (ticketId=null)
- \`discovery\` — Find new tickets to work on (focusId=null, jobId="discovery")
- \`progress-update\` — Update progress file (focusId=null, jobId="progress-update")
- \`codebase-review\` — Review a focus area (requires focusId, jobId="codebase-review:<focusId>")
- \`integration-test\` — Run integration tests for a category (requires focusId, jobId="integration-test:<focusId>")

## Scheduling Rules

1. **Fill all ${freeSlots} free slots.** Output exactly ${freeSlots} jobs (or fewer only if there's genuinely nothing useful to schedule).

2. **Resume in-progress tickets first.** Tickets further in the pipeline get priority — drive existing work to completion before starting new tickets.

3. **Schedule the correct NEXT stage.** Look at each ticket's pipeline stage and schedule only the next logical step. Example: if a ticket is at "research" stage, schedule "ticket:plan" next.

4. **Load balance across agents.** Distribute work across ALL available agents. Don't funnel everything through 1-2 favorites. Every agent should get work when there are enough jobs.

5. **Keep the ticket pipeline full.** If active tickets ≤ ${maxConcurrency * 2}, schedule a "discovery" job. The scheduler should never be starved for choices.

6. **Rate limit awareness.** If an agent is rate-limited, don't assign it. Include it in rateLimitedAgents and spread its work to other agents.

7. **Don't double-schedule.** Check the "Currently Running Jobs" table — never schedule a job that's already running or a second pipeline job for a ticket that already has one running.

8. **Maximize cheap agents.** Use the cheapest suitable agent for each task. Only escalate to expensive agents when the task genuinely requires it.

## Instructions
Output exactly the jobs to enqueue in the \`jobs\` array. Each job fills one concurrency slot.`;

  return (
    <Task id="ticket-scheduler" output={output} agent={agent} retries={2}>
      {prompt}
    </Task>
  );
}
