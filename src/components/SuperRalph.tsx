import { Ralph, Parallel, Sequence, Worktree, Task } from "smithers-orchestrator";
import type { SmithersCtx, AgentLike } from "smithers-orchestrator";
import { selectAllTickets, selectReviewTickets, selectProgressSummary, selectImplement, selectTestResults, selectSpecReview, selectCodeReviews, selectResearch, selectPlan, selectTicketReport, selectLand } from "../selectors";
import type { RalphOutputs } from "../selectors";
import React, { type ReactElement, type ReactNode } from "react";
import UpdateProgressPrompt from "../prompts/UpdateProgress.mdx";
import DiscoverPrompt from "../prompts/Discover.mdx";
import IntegrationTestPrompt from "../prompts/IntegrationTest.mdx";
import ResearchPrompt from "../prompts/Research.mdx";
import PlanPrompt from "../prompts/Plan.mdx";
import ImplementPrompt from "../prompts/Implement.mdx";
import TestPrompt from "../prompts/Test.mdx";
import BuildVerifyPrompt from "../prompts/BuildVerify.mdx";
import SpecReviewPrompt from "../prompts/SpecReview.mdx";
import CodeReviewPrompt from "../prompts/CodeReview.mdx";
import ReviewFixPrompt from "../prompts/ReviewFix.mdx";
import ReportPrompt from "../prompts/Report.mdx";
import CategoryReviewPrompt from "../prompts/CategoryReview.mdx";
import { type MergeQueueOrderingStrategy } from "../mergeQueue/coordinator";
import { computePipelineStage, type TicketSchedulerTicket } from "./TicketScheduler";
import { TicketScheduler, type TicketSchedule } from "./TicketScheduler";
import { AgenticMergeQueue } from "./AgenticMergeQueue";
import { getAgentRegistry } from "../agentRegistry";

// Main component props (simple API)
export type SuperRalphProps = {
  ctx: SmithersCtx<RalphOutputs>;
  focuses: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  outputs: RalphOutputs;

  // Project config (flattened)
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

  /** Named agent pool — the scheduler reads descriptions to decide which agent handles each task */
  agents: Record<string, {
    agent: any;
    description: string;
    tier?: "high" | "medium" | "low";
  }>;

  /** Which agent ID to use for the scheduler itself (must exist in agents map) */
  schedulerAgentId?: string;

  /** Path to the workflow SQLite database for cross-run durability */
  dbPath?: string;

  // Configuration
  progressFile?: string;
  findingsFile?: string;
  commitConfig?: {
    prefix?: string;
    mainBranch?: string;
    emojiPrefixes?: string;
  };
  testSuites?: Array<{
    name: string;
    command: string;
    description: string;
  }>;
  focusTestSuites?: Record<string, { suites: string[]; setupHints: string[]; testDirs: string[] }>;
  focusDirs?: Record<string, string[]>;
  /** Fast CI checks run in the worktree before entering the merge queue (unit tests, build, type checks) */
  preLandChecks?: string[];
  /** Slow CI checks run after rebase in the merge queue (e2e tests, integration tests, full suite) */
  postLandChecks?: string[];
  /** Queue ordering strategy for speculative land queue */
  mergeQueueOrdering?: MergeQueueOrderingStrategy;
  /** Max number of speculative queue entries to rebase + test in parallel */
  maxSpeculativeDepth?: number;
  /** Merge queue id used to isolate coordinator state */
  mergeQueueId?: string;
  skipPhases?: Set<string>;

  // Advanced: Override any step with custom component
  updateProgress?: ReactElement;
  discover?: ReactElement;
  integrationTest?: ReactElement;
  categoryReview?: ReactElement;
  research?: ReactElement;
  plan?: ReactElement;
  implement?: ReactElement;
  test?: ReactElement;
  buildVerify?: ReactElement;
  specReview?: ReactElement;
  codeReview?: ReactElement;
  reviewFix?: ReactElement;
  report?: ReactElement;
  land?: ReactElement;

  // Specs as children
  children?: ReactNode;
};

type AgentPoolEntry = { agent: any; description: string; tier?: "high" | "medium" | "low" };
type AgentPool = Record<string, AgentPoolEntry>;

/**
 * Look up an agent by ID from the named pool.
 * Falls back to the first agent in the pool if not found.
 */
function resolveAgent(pool: AgentPool, agentId: string | undefined): AgentLike {
  if (agentId && pool[agentId]) return pool[agentId].agent;
  const entries = Object.values(pool);
  return entries[0]?.agent;
}

/**
 * Build an agent list ordered by preference for a ticket.
 * If the scheduler assigned a specific agent, put it first; rest are fallbacks.
 * Returns typed as the union that Task's agent prop accepts.
 */
function buildAgentList(pool: AgentPool, assignedAgentId: string | undefined, fallbackIndex: number): AgentLike | AgentLike[] {
  const agents = Object.entries(pool);
  if (!agents.length) return [] as unknown as AgentLike;
  const list: AgentLike[] = [];
  if (assignedAgentId && pool[assignedAgentId]) {
    list.push(pool[assignedAgentId].agent);
    for (const [id, e] of agents) {
      if (id !== assignedAgentId) list.push(e.agent);
    }
  } else {
    const offset = fallbackIndex % agents.length;
    for (let i = 0; i < agents.length; i++) {
      list.push(agents[(offset + i) % agents.length][1].agent);
    }
  }
  return list.length === 1 ? list[0] : list;
}

/**
 * Build a markdown description of the agent pool for the scheduler prompt.
 */
function buildAgentPoolDescription(pool: AgentPool): string {
  const entries = Object.entries(pool);
  if (entries.length === 0) return "(no agents registered)";
  const rows = entries.map(([id, { description, tier }]) =>
    `| ${id} | ${tier ?? "medium"} | ${description} |`
  );
  return [
    "| Agent ID | Tier | Description |",
    "|----------|------|-------------|",
    ...rows,
  ].join("\n");
}

function readIteration(row: unknown): number {
  const n = Number((row as any)?.iteration);
  return Number.isFinite(n) ? n : 0;
}

function formatEvictionContext(land: any): string | null {
  if (!land || land.merged === true || land.evicted !== true) return null;
  const sections = [
    land.evictionReason ? `Reason: ${land.evictionReason}` : null,
    land.evictionDetails ? `Details:\n${land.evictionDetails}` : null,
    land.attemptedLog ? `Attempted commit history:\n${land.attemptedLog}` : null,
    land.attemptedDiffSummary ? `Attempted diff summary:\n${land.attemptedDiffSummary}` : null,
    land.landedOnMainSinceBranch ? `Mainline changes since branch point:\n${land.landedOnMainSinceBranch}` : null,
  ].filter(Boolean);
  return sections.length > 0 ? sections.join("\n\n") : null;
}

export function SuperRalph({
  ctx,
  focuses,
  outputs,
  projectId,
  projectName,
  specsPath,
  referenceFiles,
  buildCmds,
  testCmds,
  codeStyle,
  reviewChecklist,
  maxConcurrency,
  taskRetries = 3,
  agents: agentPool,
  schedulerAgentId,
  dbPath,
  progressFile = "PROGRESS.md",
  findingsFile = "docs/test-suite-findings.md",
  commitConfig = {},
  testSuites = [],
  focusTestSuites = {},
  focusDirs = {},
  preLandChecks = [],
  postLandChecks = [],
  mergeQueueOrdering = "report-complete-fifo",
  maxSpeculativeDepth = 3,
  mergeQueueId = "land-queue",
  skipPhases = new Set(),

  // Advanced overrides
  updateProgress: customUpdateProgress,
  discover: customDiscover,
  integrationTest: customIntegrationTest,
  categoryReview: customCategoryReview,
  research: customResearch,
  plan: customPlan,
  implement: customImplement,
  test: customTest,
  buildVerify: customBuildVerify,
  specReview: customSpecReview,
  codeReview: customCodeReview,
  reviewFix: customReviewFix,
  report: customReport,
  land: customLand,

  children,
}: SuperRalphProps) {
  const { findings: reviewFindings } = selectReviewTickets(ctx, focuses);
  const { completed: completedTicketIds, unfinished: unfinishedTickets } = selectAllTickets(ctx, focuses);
  const progressSummary = selectProgressSummary(ctx);

  const { prefix = "📝", mainBranch = "main", emojiPrefixes = "✨ feat, 🐛 fix, ♻️ refactor, 📝 docs, 🧪 test" } = commitConfig;

  // Resolve agents from the named pool
  const agentIds = Object.keys(agentPool);
  const defaultAgentId = agentIds[0];
  const schedulerAgent = resolveAgent(agentPool, schedulerAgentId ?? defaultAgentId);

  const ciCommands = postLandChecks.length > 0 ? postLandChecks : Object.values(testCmds);

  // Build agent pool description for the scheduler prompt (from the user-provided descriptions)
  const agentPoolContext = buildAgentPoolDescription(agentPool);

  // Auto-register agents in the AgentRegistry for stats tracking
  const agentRegistry = getAgentRegistry();
  for (const [id, { tier }] of Object.entries(agentPool)) {
    if (!agentRegistry.getAgentStatsById(id)) {
      agentRegistry.registerAgent(id, { id, type: "custom", tier: tier ?? "medium" });
    }
  }

  // Compute ticket state with pipeline stages for priority sorting
  const ticketState = unfinishedTickets.map((ticket) => {
    const latestLand = selectLand(ctx, ticket.id);
    const latestReport = selectTicketReport(ctx, ticket.id);
    const landed = latestLand?.merged === true;
    const evictedPendingRework = latestLand?.evicted === true && latestLand?.merged !== true;
    const reportComplete = latestReport?.status === "complete" && !evictedPendingRework;
    const pipelineStage = computePipelineStage(ctx, ticket.id);
    return {
      ticket,
      latestLand,
      latestReport,
      landed,
      reportComplete,
      pipelineStage,
      evictionContext: formatEvictionContext(latestLand),
    };
  });

  // Sort tickets by pipeline stage (most advanced first), then by priority
  const STAGE_ORDER: Record<string, number> = {
    landed: 100, report: 90, review_fix: 80, code_review: 70, spec_review: 65,
    build_verify: 60, test: 50, implement: 40, plan: 30, research: 20, not_started: 0,
  };
  const PRIORITY_ORDER: Record<string, number> = { critical: 40, high: 30, medium: 20, low: 10 };

  const sortedTicketState = [...ticketState].sort((a, b) => {
    const stageA = STAGE_ORDER[a.pipelineStage] ?? 0;
    const stageB = STAGE_ORDER[b.pipelineStage] ?? 0;
    if (stageA !== stageB) return stageB - stageA; // higher stage first
    const prioA = PRIORITY_ORDER[a.ticket.priority] ?? 0;
    const prioB = PRIORITY_ORDER[b.ticket.priority] ?? 0;
    return prioB - prioA; // higher priority first
  });

  // Build scheduler ticket data
  const schedulerTickets: TicketSchedulerTicket[] = sortedTicketState.map((t) => ({
    ticket: t.ticket,
    pipelineStage: t.pipelineStage,
    landed: t.landed,
    reportComplete: t.reportComplete,
    hasImplementation: !!selectImplement(ctx, t.ticket.id),
    hasTestResults: !!selectTestResults(ctx, t.ticket.id),
    hasReview: !!selectSpecReview(ctx, t.ticket.id) || selectCodeReviews(ctx, t.ticket.id).worstSeverity !== "none",
    evictionContext: t.evictionContext,
  }));

  // Read the scheduler's output (from previous iteration) for agent assignments
  const schedulerOutput = ctx.outputMaybe("ticket_schedule" as any, { nodeId: "ticket-scheduler" }) as TicketSchedule | undefined;
  const assignmentMap = new Map<string, string>(); // ticketId -> agentId
  if (schedulerOutput?.assignments) {
    for (const a of schedulerOutput.assignments) {
      if (!a.shouldSkip) assignmentMap.set(a.ticketId, a.assignedAgentId);
    }
  }

  // Merge queue tickets
  const mergeQueueTickets = sortedTicketState.map((t) => ({
    ticketId: t.ticket.id,
    ticketTitle: t.ticket.title,
    ticketCategory: t.ticket.category,
    priority: t.ticket.priority,
    reportComplete: t.reportComplete,
    landed: t.landed,
    worktreePath: `/tmp/workflow-wt-${t.ticket.id}`,
  }));

  return (
    <Ralph until={false} maxIterations={Infinity} onMaxReached="return-last">
      <Parallel maxConcurrency={maxConcurrency}>
        {/* TicketScheduler: AI-driven orchestrator that decides how to fill concurrency slots */}
        {!skipPhases.has("TICKETS") && (
          <TicketScheduler
            ctx={ctx}
            tickets={schedulerTickets}
            agentPoolContext={agentPoolContext}
            focuses={focuses}
            maxConcurrency={maxConcurrency}
            agent={schedulerAgent}
            output={outputs.ticket_schedule ?? outputs.progress}
            completedTicketIds={completedTicketIds}
            totalDiscoveredTickets={unfinishedTickets.length + completedTicketIds.length}
          />
        )}

        {/* Progress update: only when scheduler says so */}
        {!skipPhases.has("PROGRESS") && schedulerOutput?.triggerProgressUpdate && (customUpdateProgress || (
          <Worktree id="wt-update-progress" path="/tmp/workflow-wt-update-progress">
            <Task id="update-progress" output={outputs.progress} agent={buildAgentList(agentPool, undefined, 1)} retries={taskRetries}>
              <UpdateProgressPrompt
                projectName={projectName}
                progressFile={progressFile}
                commitMessage={`${prefix} docs: update progress`}
                completedTickets={completedTicketIds}
              />
            </Task>
          </Worktree>
        ))}

        {/* Codebase reviews: only when scheduler says so */}
        {!skipPhases.has("CODEBASE_REVIEW") && schedulerOutput?.triggerCodebaseReview && (customCategoryReview ? (
          customCategoryReview
        ) : (
          <Parallel maxConcurrency={maxConcurrency}>
            {focuses.map(({ id, name }, focusIdx) => (
              <Worktree key={id} id={`wt-codebase-review-${id}`} path={`/tmp/workflow-wt-codebase-review-${id}`}>
                <Task id={`codebase-review:${id}`} output={outputs.category_review} agent={buildAgentList(agentPool, undefined, focusIdx)} retries={taskRetries}>
                  <CategoryReviewPrompt categoryId={id} categoryName={name} relevantDirs={focusDirs[id] ?? null} />
                </Task>
              </Worktree>
            ))}
          </Parallel>
        ))}

        {/* Discovery: only when scheduler says so */}
        {!skipPhases.has("DISCOVER") && schedulerOutput?.triggerDiscovery && (customDiscover || (
          <Worktree id="wt-discover" path="/tmp/workflow-wt-discover">
            <Task id="discover" output={outputs.discover} agent={buildAgentList(agentPool, undefined, 2)} retries={taskRetries}>
              <DiscoverPrompt
                projectName={projectName}
                specsPath={specsPath}
                referenceFiles={referenceFiles}
                categories={focuses}
                completedTicketIds={completedTicketIds}
                previousProgress={progressSummary}
                reviewFindings={reviewFindings}
              />
            </Task>
          </Worktree>
        ))}

        {/* Integration tests: triggered by scheduler for specific categories */}
        {!skipPhases.has("INTEGRATION_TEST") && (customIntegrationTest || (
          <Parallel maxConcurrency={maxConcurrency}>
            {(() => {
              const scheduledCategories = schedulerOutput?.triggerIntegrationTests ?? [];
              const categoriesToTest = scheduledCategories.length > 0
                ? focuses.filter(({ id }) => scheduledCategories.includes(id))
                : []; // Only run what the scheduler explicitly requests
              return categoriesToTest.map(({ id, name }, testIdx) => {
                const suiteInfo = focusTestSuites[id] ?? { suites: [], setupHints: [], testDirs: [] };
                return (
                  <Worktree key={id} id={`wt-integration-test-${id}`} path={`/tmp/workflow-wt-integration-test-${id}`}>
                    <Task id={`integration-test:${id}`} output={outputs.integration_test} agent={buildAgentList(agentPool, undefined, testIdx + 3)} retries={taskRetries}>
                      <IntegrationTestPrompt
                        categoryId={id}
                        categoryName={name}
                        suites={suiteInfo.suites}
                        setupHints={suiteInfo.setupHints}
                        testDirs={suiteInfo.testDirs}
                        findingsFile={findingsFile}
                      />
                    </Task>
                  </Worktree>
                );
              });
            })()}
          </Parallel>
        ))}

        {/* Scheduler-driven ticket pipelines (sorted by stage + priority, dynamic agent assignment) */}
        {sortedTicketState.map((ticketRuntime, ticketIndex) => {
          const ticket = ticketRuntime.ticket;
          const researchData = selectResearch(ctx, ticket.id);
          const planData = selectPlan(ctx, ticket.id);
          const contextFilePath = researchData?.contextFilePath ?? `docs/context/${ticket.id}.md`;
          const planFilePath = planData?.planFilePath ?? `docs/plans/${ticket.id}.md`;
          const landed = ticketRuntime.landed;
          const reportComplete = ticketRuntime.reportComplete;
          const evictionContext = ticketRuntime.evictionContext;

          // Check if scheduler says to skip this ticket
          const assignment = schedulerOutput?.assignments?.find((a) => a.ticketId === ticket.id);
          if (assignment?.shouldSkip) return null;

          // Dynamic agent assignment: scheduler picks the agent, pool provides fallbacks
          const assignedAgentId = assignmentMap.get(ticket.id);
          const ticketAgentList = buildAgentList(agentPool, assignedAgentId, ticketIndex);

          return (
            <Sequence key={ticket.id} skipIf={landed}>
              {/* Phase 1: Development (in worktree, on branch) */}
              <Worktree id={`wt-${ticket.id}`} path={`/tmp/workflow-wt-${ticket.id}`}>
                <Sequence skipIf={reportComplete}>
                  {customResearch || (
                    <Task id={`${ticket.id}:research`} output={outputs.research} agent={ticketAgentList} retries={taskRetries}>
                      <ResearchPrompt
                        ticketId={ticket.id}
                        ticketTitle={ticket.title}
                        ticketDescription={ticket.description}
                        ticketCategory={ticket.category}
                        referenceFiles={ticket.referenceFiles}
                        relevantFiles={ticket.relevantFiles}
                        contextFilePath={contextFilePath}
                        referencePaths={[specsPath, ...referenceFiles]}
                        evictionContext={evictionContext}
                      />
                    </Task>
                  )}

                  {customPlan || (
                    <Task id={`${ticket.id}:plan`} output={outputs.plan} agent={ticketAgentList} retries={taskRetries}>
                      <PlanPrompt
                        ticketId={ticket.id}
                        ticketTitle={ticket.title}
                        ticketDescription={ticket.description}
                        ticketCategory={ticket.category}
                        acceptanceCriteria={ticket.acceptanceCriteria ?? []}
                        contextFilePath={contextFilePath}
                        researchSummary={researchData?.summary ?? null}
                        evictionContext={evictionContext}
                        planFilePath={planFilePath}
                        tddPatterns={["Write tests FIRST, then implementation"]}
                        commitPrefix={prefix}
                        mainBranch={mainBranch}
                      />
                    </Task>
                  )}

                  {/* ValidationLoop */}
                  <Sequence>
                    {(() => {
                      const latestImplement = selectImplement(ctx, ticket.id);
                      const latestTest = selectTestResults(ctx, ticket.id);
                      const latestSpecReview = selectSpecReview(ctx, ticket.id);
                      const { worstSeverity: worstCodeSeverity, mergedIssues: mergedCodeIssues, mergedFeedback: mergedCodeFeedback } = selectCodeReviews(ctx, ticket.id);

                      const specApproved = latestSpecReview?.severity === "none";
                      const codeApproved = worstCodeSeverity === "none";
                      const noReviewIssues = specApproved && codeApproved;

                      const toArray = (v: unknown): string[] => Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
                      const reviewFeedback = (() => {
                        const parts: string[] = [];
                        if (latestSpecReview && !specApproved) {
                          parts.push(`SPEC REVIEW (${latestSpecReview.severity}): ${latestSpecReview.feedback}`);
                          if (latestSpecReview.issues) parts.push(`Issues: ${toArray(latestSpecReview.issues).join("; ")}`);
                        }
                        if (!codeApproved && mergedCodeFeedback) {
                          parts.push(`CODE REVIEW (${worstCodeSeverity}): ${mergedCodeFeedback}`);
                          if (mergedCodeIssues.length > 0) parts.push(`Issues: ${mergedCodeIssues.join("; ")}`);
                        }
                        return parts.length > 0 ? parts.join("\n\n") : null;
                      })();

                      return (
                        <>
                          {customImplement || (
                            <Task id={`${ticket.id}:implement`} output={outputs.implement} agent={ticketAgentList} retries={taskRetries}>
                              <ImplementPrompt
                                ticketId={ticket.id}
                                ticketTitle={ticket.title}
                                ticketCategory={ticket.category}
                                planFilePath={planFilePath}
                                contextFilePath={contextFilePath}
                                implementationSteps={planData?.implementationSteps ?? null}
                                previousImplementation={latestImplement ?? null}
                                evictionContext={evictionContext}
                                reviewFeedback={reviewFeedback}
                                failingTests={latestTest?.failingSummary ?? null}
                                testWritingGuidance={["Write unit tests AND integration tests"]}
                                implementationGuidance={["Follow architecture patterns from specs"]}
                                formatterCommands={Object.entries(buildCmds).map(([lang, cmd]) => `Format ${lang}`)}
                                verifyCommands={Object.values(buildCmds)}
                                architectureRules={[`Read ${specsPath} for patterns`]}
                                commitPrefix={prefix}
                                mainBranch={mainBranch}
                                emojiPrefixes={emojiPrefixes}
                              />
                            </Task>
                          )}

                          {customTest || (
                            <Task id={`${ticket.id}:test`} output={outputs.test_results} agent={ticketAgentList} retries={taskRetries}>
                              <TestPrompt
                                ticketId={ticket.id}
                                ticketTitle={ticket.title}
                                ticketCategory={ticket.category}
                                testSuites={testSuites.length > 0 ? testSuites : Object.entries(testCmds).map(([name, command]) => ({
                                  name: `${name} tests`,
                                  command,
                                  description: `Run ${name} tests`,
                                }))}
                                fixCommitPrefix={`🐛 fix`}
                                mainBranch={mainBranch}
                              />
                            </Task>
                          )}

                          {customBuildVerify || (
                            <Task id={`${ticket.id}:build-verify`} output={outputs.build_verify} agent={ticketAgentList} retries={taskRetries}>
                              <BuildVerifyPrompt
                                ticketId={ticket.id}
                                ticketTitle={ticket.title}
                                ticketCategory={ticket.category}
                                filesCreated={latestImplement?.filesCreated ?? null}
                                filesModified={latestImplement?.filesModified ?? null}
                                whatWasDone={latestImplement?.whatWasDone ?? null}
                              />
                            </Task>
                          )}

                          <Parallel maxConcurrency={maxConcurrency}>
                            {customSpecReview || (
                              <Task id={`${ticket.id}:spec-review`} output={outputs.spec_review} agent={ticketAgentList} retries={taskRetries}>
                                <SpecReviewPrompt
                                  ticketId={ticket.id}
                                  ticketTitle={ticket.title}
                                  ticketCategory={ticket.category}
                                  filesCreated={latestImplement?.filesCreated ?? null}
                                  filesModified={latestImplement?.filesModified ?? null}
                                  testResults={[
                                    { name: "Tests", status: latestTest?.goTestsPassed ? "PASS" : "FAIL" },
                                  ]}
                                  failingSummary={latestTest?.failingSummary ?? null}
                                  specChecks={[
                                    { name: "Code Style", items: [codeStyle] },
                                    { name: "Review Checklist", items: reviewChecklist },
                                  ]}
                                />
                              </Task>
                            )}

                            {customCodeReview || (
                              <Task id={`${ticket.id}:code-review`} output={outputs.code_review} agent={ticketAgentList} retries={taskRetries}>
                                <CodeReviewPrompt
                                  ticketId={ticket.id}
                                  ticketTitle={ticket.title}
                                  ticketCategory={ticket.category}
                                  filesCreated={latestImplement?.filesCreated ?? null}
                                  filesModified={latestImplement?.filesModified ?? null}
                                  reviewChecklist={reviewChecklist}
                                />
                              </Task>
                            )}
                          </Parallel>

                          {customReviewFix || (!noReviewIssues && (
                            <Task id={`${ticket.id}:review-fix`} output={outputs.review_fix} agent={ticketAgentList} retries={taskRetries}>
                              <ReviewFixPrompt
                                ticketId={ticket.id}
                                ticketTitle={ticket.title}
                                ticketCategory={ticket.category}
                                specSeverity={latestSpecReview?.severity ?? "none"}
                                specFeedback={latestSpecReview?.feedback ?? ""}
                                specIssues={latestSpecReview?.issues ?? null}
                                codeSeverity={worstCodeSeverity}
                                codeFeedback={mergedCodeFeedback}
                                codeIssues={mergedCodeIssues.length > 0 ? mergedCodeIssues : null}
                                validationCommands={Object.values(testCmds)}
                                commitPrefix={`🐛 fix`}
                                mainBranch={mainBranch}
                                emojiPrefixes={emojiPrefixes}
                              />
                            </Task>
                          ))}
                        </>
                      );
                    })()}
                  </Sequence>

                  {customReport || (
                    <Task id={`${ticket.id}:report`} output={outputs.report} agent={ticketAgentList} retries={taskRetries}>
                      <ReportPrompt
                        ticketId={ticket.id}
                        ticketTitle={ticket.title}
                        ticketCategory={ticket.category}
                        acceptanceCriteria={ticket.acceptanceCriteria ?? []}
                        specSeverity={selectSpecReview(ctx, ticket.id)?.severity ?? "none"}
                        codeSeverity={selectCodeReviews(ctx, ticket.id).worstSeverity}
                        allIssuesResolved={(ctx.outputMaybe("review_fix", { nodeId: `${ticket.id}:review-fix` }) as any)?.allIssuesResolved ?? true}
                        reviewRounds={1}
                        goTests={selectTestResults(ctx, ticket.id)?.goTestsPassed ? "PASS" : "FAIL"}
                        rustTests={selectTestResults(ctx, ticket.id)?.rustTestsPassed ? "PASS" : "FAIL"}
                        e2eTests={selectTestResults(ctx, ticket.id)?.e2eTestsPassed ? "PASS" : "FAIL"}
                        sqlcGen={selectTestResults(ctx, ticket.id)?.sqlcGenPassed ? "PASS" : "FAIL"}
                      />
                    </Task>
                  )}
                </Sequence>
              </Worktree>
            </Sequence>
          );
        })}

        {/* Agentic Merge Queue: single Task on main that lands all ready tickets */}
        {customLand || (
          <AgenticMergeQueue
            ctx={ctx}
            outputs={outputs}
            tickets={mergeQueueTickets}
            agent={resolveAgent(agentPool, schedulerAgentId ?? defaultAgentId)}
            postLandChecks={ciCommands}
            preLandChecks={preLandChecks}
            repoRoot={process.cwd()}
            mainBranch={mainBranch}
            maxSpeculativeDepth={maxSpeculativeDepth}
            output={outputs.land}
          />
        )}
      </Parallel>
    </Ralph>
  );
}

// Compound components for advanced customization
SuperRalph.UpdateProgress = function UpdateProgress(_props: any) { return null; };
SuperRalph.Discover = function Discover(_props: any) { return null; };
SuperRalph.IntegrationTest = function IntegrationTest(_props: any) { return null; };
SuperRalph.CategoryReview = function CategoryReview(_props: any) { return null; };
SuperRalph.Research = function Research(_props: any) { return null; };
SuperRalph.Plan = function Plan(_props: any) { return null; };
SuperRalph.Implement = function Implement(_props: any) { return null; };
SuperRalph.Test = function Test(_props: any) { return null; };
SuperRalph.BuildVerify = function BuildVerify(_props: any) { return null; };
SuperRalph.SpecReview = function SpecReview(_props: any) { return null; };
SuperRalph.CodeReview = function CodeReview(_props: any) { return null; };
SuperRalph.ReviewFix = function ReviewFix(_props: any) { return null; };
SuperRalph.Report = function Report(_props: any) { return null; };
SuperRalph.Land = function Land(_props: any) { return null; };
