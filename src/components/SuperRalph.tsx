import { Ralph, Parallel } from "smithers-orchestrator";
import type { SmithersCtx, AgentLike } from "smithers-orchestrator";
import { selectAllTickets, selectReviewTickets, selectProgressSummary, selectLand, selectTicketReport } from "../selectors";
import type { RalphOutputs, Ticket } from "../selectors";
import React, { type ReactNode } from "react";
import Database from "better-sqlite3";
import { type MergeQueueOrderingStrategy } from "../mergeQueue/coordinator";
import { computePipelineStage, isJobComplete, type TicketSchedule, type TicketState } from "./TicketScheduler";
import { TicketScheduler } from "./TicketScheduler";
import { AgenticMergeQueue } from "./AgenticMergeQueue";
import { Job } from "./Job";
import { ensureTable, insertJob, removeJob, getActiveJobs } from "../scheduledTasks";

// --- Props ---

export type SuperRalphProps = {
  ctx: SmithersCtx<RalphOutputs>;
  focuses: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  outputs: RalphOutputs;

  projectId: string;
  projectName: string;
  specsPath: string;
  referenceFiles: string[];
  buildCmds: Record<string, string>;
  testCmds: Record<string, string>;
  codeStyle: string;
  reviewChecklist: string[];

  maxConcurrency: number;
  taskRetries?: number;

  agents: Record<string, {
    agent: any;
    description: string;
    isScheduler?: boolean;
    isMergeQueue?: boolean;
  }>;

  dbPath?: string;
  progressFile?: string;
  findingsFile?: string;
  commitConfig?: { prefix?: string; mainBranch?: string; emojiPrefixes?: string };
  testSuites?: Array<{ name: string; command: string; description: string }>;
  focusTestSuites?: Record<string, { suites: string[]; setupHints: string[]; testDirs: string[] }>;
  focusDirs?: Record<string, string[]>;
  preLandChecks?: string[];
  postLandChecks?: string[];
  mergeQueueOrdering?: MergeQueueOrderingStrategy;
  maxSpeculativeDepth?: number;
  mergeQueueId?: string;
  children?: ReactNode;
};

type AgentPool = Record<string, { agent: any; description: string; isScheduler?: boolean; isMergeQueue?: boolean }>;

function resolveAgent(pool: AgentPool, agentId: string | undefined): AgentLike {
  if (agentId && pool[agentId]) return pool[agentId].agent;
  return Object.values(pool)[0]?.agent;
}

function buildAgentPoolDescription(pool: AgentPool): string {
  const entries = Object.entries(pool);
  if (entries.length === 0) return "(no agents registered)";
  const rows = entries.map(([id, { description }]) => `| ${id} | ${description} |`);
  return ["| Agent ID | Description |", "|----------|-------------|", ...rows].join("\n");
}

// --- Main Component ---

export function SuperRalph({
  ctx, focuses, outputs,
  projectId, projectName, specsPath, referenceFiles, buildCmds, testCmds,
  codeStyle, reviewChecklist, maxConcurrency, taskRetries = 3,
  agents: agentPool,
  dbPath = "./scheduled-tasks.db",
  progressFile = "PROGRESS.md",
  findingsFile = "docs/test-suite-findings.md",
  commitConfig = {},
  testSuites = [],
  focusTestSuites = {},
  focusDirs = {},
  preLandChecks = [],
  postLandChecks = [],
  maxSpeculativeDepth = 3,
}: SuperRalphProps) {

  const { findings: reviewFindings } = selectReviewTickets(ctx, focuses);
  const { completed: completedTicketIds, unfinished: unfinishedTickets } = selectAllTickets(ctx, focuses);
  const progressSummary = selectProgressSummary(ctx);
  const { prefix = "📝", mainBranch = "main", emojiPrefixes = "✨ feat, 🐛 fix, ♻️ refactor, 📝 docs, 🧪 test" } = commitConfig;

  // Resolve scheduler + merge queue agents from pool flags
  const agentIds = Object.keys(agentPool);
  const defaultAgentId = agentIds[0];
  const schedulerAgentId = Object.entries(agentPool).find(([, e]) => e.isScheduler)?.[0] ?? defaultAgentId;
  const mergeQueueAgentId = Object.entries(agentPool).find(([, e]) => e.isMergeQueue)?.[0] ?? schedulerAgentId;
  const schedulerAgent = resolveAgent(agentPool, schedulerAgentId);
  const agentPoolContext = buildAgentPoolDescription(agentPool);
  const ciCommands = postLandChecks.length > 0 ? postLandChecks : Object.values(testCmds);

  // Lookups
  const ticketMap = new Map<string, Ticket>(unfinishedTickets.map(t => [t.id, t]));
  const focusMap = new Map(focuses.map(f => [f.id, f]));

  // Ticket pipeline states (for scheduler context)
  const ticketStates: TicketState[] = unfinishedTickets.map(ticket => ({
    ticket,
    pipelineStage: computePipelineStage(ctx, ticket.id),
    landed: selectLand(ctx, ticket.id)?.merged === true,
    reportComplete: (() => {
      const land = selectLand(ctx, ticket.id);
      const report = selectTicketReport(ctx, ticket.id);
      const evicted = land?.evicted === true && land?.merged !== true;
      return report?.status === "complete" && !evicted;
    })(),
  }));

  // Merge queue tickets
  const mergeQueueTickets = ticketStates
    .filter(t => t.reportComplete && !t.landed)
    .map(t => ({
      ticketId: t.ticket.id, ticketTitle: t.ticket.title,
      ticketCategory: t.ticket.category, priority: t.ticket.priority,
      reportComplete: t.reportComplete, landed: t.landed,
      worktreePath: `/tmp/workflow-wt-${t.ticket.id}`,
    }));

  // --- Scheduled tasks: reap → reconcile → read ---
  const db = new Database(dbPath);
  ensureTable(db);

  for (const job of getActiveJobs(db)) {
    if (isJobComplete(ctx, job)) removeJob(db, job.jobId);
  }

  const schedulerOutput = ctx.outputMaybe("ticket_schedule" as any, { nodeId: "ticket-scheduler" }) as TicketSchedule | undefined;
  if (schedulerOutput?.jobs) {
    for (const job of schedulerOutput.jobs) {
      insertJob(db, { jobId: job.jobId, jobType: job.jobType, agentId: job.agentId, ticketId: job.ticketId ?? null, focusId: job.focusId ?? null, createdAtMs: Date.now() });
    }
  }

  const activeJobs = getActiveJobs(db);
  const activeCount = activeJobs.length;
  db.close();

  // Shared props for <Job /> components
  const jobProps = {
    ctx, outputs, retries: taskRetries,
    ticketMap, focusMap,
    projectName, specsPath, referenceFiles, buildCmds, testCmds,
    codeStyle, reviewChecklist, progressFile, findingsFile,
    prefix, mainBranch, emojiPrefixes, testSuites, focusTestSuites, focusDirs,
    completedTicketIds, progressSummary, reviewFindings, focuses,
  };

  return (
    <Ralph until={false} maxIterations={Infinity} onMaxReached="return-last">
      <Parallel maxConcurrency={maxConcurrency}>
        {activeCount < maxConcurrency && (
          <TicketScheduler
            ctx={ctx} ticketStates={ticketStates} activeJobs={activeJobs}
            agentPoolContext={agentPoolContext} focuses={focuses}
            maxConcurrency={maxConcurrency} agent={schedulerAgent}
            output={outputs.ticket_schedule} completedTicketIds={completedTicketIds}
          />
        )}

        {activeJobs.map(job => (
          <Job key={job.jobId} job={job} agent={resolveAgent(agentPool, job.agentId)} {...jobProps} />
        ))}

        <AgenticMergeQueue
          ctx={ctx} outputs={outputs} tickets={mergeQueueTickets}
          agent={resolveAgent(agentPool, mergeQueueAgentId)}
          postLandChecks={ciCommands} preLandChecks={preLandChecks}
          repoRoot={process.cwd()} mainBranch={mainBranch}
          maxSpeculativeDepth={maxSpeculativeDepth} output={outputs.land}
        />
      </Parallel>
    </Ralph>
  );
}
