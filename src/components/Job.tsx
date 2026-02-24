import React from "react";
import { Worktree, Task } from "smithers-orchestrator";
import type { SmithersCtx, AgentLike } from "smithers-orchestrator";
import { selectResearch, selectPlan, selectImplement, selectTestResults, selectSpecReview, selectCodeReviews, selectLand } from "../selectors";
import type { RalphOutputs, Ticket } from "../selectors";
import type { ScheduledJob } from "../scheduledTasks";
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

export type JobProps = {
  job: ScheduledJob;
  ctx: SmithersCtx<RalphOutputs>;
  outputs: RalphOutputs;
  agent: AgentLike;
  retries: number;

  // Lookups
  ticketMap: Map<string, Ticket>;
  focusMap: Map<string, { id: string; name: string }>;

  // Project config
  projectName: string;
  specsPath: string;
  referenceFiles: string[];
  buildCmds: Record<string, string>;
  testCmds: Record<string, string>;
  codeStyle: string;
  reviewChecklist: string[];
  progressFile: string;
  findingsFile: string;
  prefix: string;
  mainBranch: string;
  emojiPrefixes: string;
  testSuites: Array<{ name: string; command: string; description: string }>;
  focusTestSuites: Record<string, { suites: string[]; setupHints: string[]; testDirs: string[] }>;
  focusDirs: Record<string, string[]>;
  completedTicketIds: string[];
  progressSummary: string | null;
  reviewFindings: string | null;
  focuses: ReadonlyArray<{ readonly id: string; readonly name: string }>;
};

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

function wrapWorktree(id: string, child: React.ReactElement) {
  return <Worktree id={`wt-${id}`} path={`/tmp/workflow-wt-${id}`}>{child}</Worktree>;
}

export function Job({
  job, ctx, outputs, agent, retries,
  ticketMap, focusMap,
  projectName, specsPath, referenceFiles, buildCmds, testCmds,
  codeStyle, reviewChecklist, progressFile, findingsFile,
  prefix, mainBranch, emojiPrefixes, testSuites, focusTestSuites, focusDirs,
  completedTicketIds, progressSummary, reviewFindings, focuses,
}: JobProps) {
  switch (job.jobType) {
    // --- Global jobs ---
    case "discovery":
      return wrapWorktree("discover",
        <Task id={job.jobId} output={outputs.discover} agent={agent} retries={retries}>
          <DiscoverPrompt
            projectName={projectName} specsPath={specsPath} referenceFiles={referenceFiles}
            categories={focuses} completedTicketIds={completedTicketIds}
            previousProgress={progressSummary} reviewFindings={reviewFindings}
          />
        </Task>
      );

    case "progress-update":
      return wrapWorktree("update-progress",
        <Task id={job.jobId} output={outputs.progress} agent={agent} retries={retries}>
          <UpdateProgressPrompt
            projectName={projectName} progressFile={progressFile}
            commitMessage={`${prefix} docs: update progress`} completedTickets={completedTicketIds}
          />
        </Task>
      );

    case "codebase-review": {
      const focus = job.focusId ? focusMap.get(job.focusId) : null;
      if (!focus) return null;
      return wrapWorktree(`codebase-review-${focus.id}`,
        <Task id={job.jobId} output={outputs.category_review} agent={agent} retries={retries}>
          <CategoryReviewPrompt categoryId={focus.id} categoryName={focus.name} relevantDirs={focusDirs[focus.id] ?? null} />
        </Task>
      );
    }

    case "integration-test": {
      const focus = job.focusId ? focusMap.get(job.focusId) : null;
      if (!focus) return null;
      const suiteInfo = focusTestSuites[focus.id] ?? { suites: [], setupHints: [], testDirs: [] };
      return wrapWorktree(`integration-test-${focus.id}`,
        <Task id={job.jobId} output={outputs.integration_test} agent={agent} retries={retries}>
          <IntegrationTestPrompt
            categoryId={focus.id} categoryName={focus.name}
            suites={suiteInfo.suites} setupHints={suiteInfo.setupHints}
            testDirs={suiteInfo.testDirs} findingsFile={findingsFile}
          />
        </Task>
      );
    }

    // --- Ticket pipeline jobs ---
    default: {
      if (!job.ticketId || !job.jobType.startsWith("ticket:")) return null;
      const ticket = ticketMap.get(job.ticketId);
      if (!ticket) return null;

      const researchData = selectResearch(ctx, ticket.id);
      const planData = selectPlan(ctx, ticket.id);
      const latestImpl = selectImplement(ctx, ticket.id);
      const latestTest = selectTestResults(ctx, ticket.id);
      const latestSpecReview = selectSpecReview(ctx, ticket.id);
      const { worstSeverity: worstCodeSeverity, mergedIssues: mergedCodeIssues, mergedFeedback: mergedCodeFeedback } = selectCodeReviews(ctx, ticket.id);
      const contextFilePath = researchData?.contextFilePath ?? `docs/context/${ticket.id}.md`;
      const planFilePath = planData?.planFilePath ?? `docs/plans/${ticket.id}.md`;
      const evictionContext = formatEvictionContext(selectLand(ctx, ticket.id));

      const toArray = (v: unknown): string[] => Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
      const reviewFeedback = (() => {
        const parts: string[] = [];
        const specApproved = latestSpecReview?.severity === "none";
        const codeApproved = worstCodeSeverity === "none";
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

      const stage = job.jobType.replace("ticket:", "");
      const taskElement = (() => {
        switch (stage) {
          case "research":
            return (
              <Task id={job.jobId} output={outputs.research} agent={agent} retries={retries}>
                <ResearchPrompt
                  ticketId={ticket.id} ticketTitle={ticket.title} ticketDescription={ticket.description}
                  ticketCategory={ticket.category} referenceFiles={ticket.referenceFiles ?? []}
                  relevantFiles={ticket.relevantFiles ?? []} contextFilePath={contextFilePath}
                  referencePaths={[specsPath, ...referenceFiles]} evictionContext={evictionContext}
                />
              </Task>
            );
          case "plan":
            return (
              <Task id={job.jobId} output={outputs.plan} agent={agent} retries={retries}>
                <PlanPrompt
                  ticketId={ticket.id} ticketTitle={ticket.title} ticketDescription={ticket.description}
                  ticketCategory={ticket.category} acceptanceCriteria={ticket.acceptanceCriteria ?? []}
                  contextFilePath={contextFilePath} researchSummary={researchData?.summary ?? null}
                  evictionContext={evictionContext} planFilePath={planFilePath}
                  tddPatterns={["Write tests FIRST, then implementation"]}
                  commitPrefix={prefix} mainBranch={mainBranch}
                />
              </Task>
            );
          case "implement":
            return (
              <Task id={job.jobId} output={outputs.implement} agent={agent} retries={retries}>
                <ImplementPrompt
                  ticketId={ticket.id} ticketTitle={ticket.title} ticketCategory={ticket.category}
                  planFilePath={planFilePath} contextFilePath={contextFilePath}
                  implementationSteps={planData?.implementationSteps ?? null}
                  previousImplementation={latestImpl ?? null} evictionContext={evictionContext}
                  reviewFeedback={reviewFeedback} failingTests={latestTest?.failingSummary ?? null}
                  testWritingGuidance={["Write unit tests AND integration tests"]}
                  implementationGuidance={["Follow architecture patterns from specs"]}
                  formatterCommands={Object.entries(buildCmds).map(([lang]) => `Format ${lang}`)}
                  verifyCommands={Object.values(buildCmds)}
                  architectureRules={[`Read ${specsPath} for patterns`]}
                  commitPrefix={prefix} mainBranch={mainBranch} emojiPrefixes={emojiPrefixes}
                />
              </Task>
            );
          case "test":
            return (
              <Task id={job.jobId} output={outputs.test_results} agent={agent} retries={retries}>
                <TestPrompt
                  ticketId={ticket.id} ticketTitle={ticket.title} ticketCategory={ticket.category}
                  testSuites={testSuites.length > 0 ? testSuites : Object.entries(testCmds).map(([name, command]) => ({
                    name: `${name} tests`, command, description: `Run ${name} tests`,
                  }))}
                  fixCommitPrefix="🐛 fix" mainBranch={mainBranch}
                />
              </Task>
            );
          case "build-verify":
            return (
              <Task id={job.jobId} output={outputs.build_verify} agent={agent} retries={retries}>
                <BuildVerifyPrompt
                  ticketId={ticket.id} ticketTitle={ticket.title} ticketCategory={ticket.category}
                  filesCreated={latestImpl?.filesCreated ?? null} filesModified={latestImpl?.filesModified ?? null}
                  whatWasDone={latestImpl?.whatWasDone ?? null}
                />
              </Task>
            );
          case "spec-review":
            return (
              <Task id={job.jobId} output={outputs.spec_review} agent={agent} retries={retries}>
                <SpecReviewPrompt
                  ticketId={ticket.id} ticketTitle={ticket.title} ticketCategory={ticket.category}
                  filesCreated={latestImpl?.filesCreated ?? null} filesModified={latestImpl?.filesModified ?? null}
                  testResults={[{ name: "Tests", status: latestTest?.goTestsPassed ? "PASS" : "FAIL" }]}
                  failingSummary={latestTest?.failingSummary ?? null}
                  specChecks={[
                    { name: "Code Style", items: [codeStyle] },
                    { name: "Review Checklist", items: reviewChecklist },
                  ]}
                />
              </Task>
            );
          case "code-review":
            return (
              <Task id={job.jobId} output={outputs.code_review} agent={agent} retries={retries}>
                <CodeReviewPrompt
                  ticketId={ticket.id} ticketTitle={ticket.title} ticketCategory={ticket.category}
                  filesCreated={latestImpl?.filesCreated ?? null} filesModified={latestImpl?.filesModified ?? null}
                  reviewChecklist={reviewChecklist}
                />
              </Task>
            );
          case "review-fix":
            return (
              <Task id={job.jobId} output={outputs.review_fix} agent={agent} retries={retries}>
                <ReviewFixPrompt
                  ticketId={ticket.id} ticketTitle={ticket.title} ticketCategory={ticket.category}
                  specSeverity={latestSpecReview?.severity ?? "none"} specFeedback={latestSpecReview?.feedback ?? ""}
                  specIssues={latestSpecReview?.issues ?? null} codeSeverity={worstCodeSeverity}
                  codeFeedback={mergedCodeFeedback} codeIssues={mergedCodeIssues.length > 0 ? mergedCodeIssues : null}
                  validationCommands={Object.values(testCmds)}
                  commitPrefix="🐛 fix" mainBranch={mainBranch} emojiPrefixes={emojiPrefixes}
                />
              </Task>
            );
          case "report":
            return (
              <Task id={job.jobId} output={outputs.report} agent={agent} retries={retries}>
                <ReportPrompt
                  ticketId={ticket.id} ticketTitle={ticket.title} ticketCategory={ticket.category}
                  acceptanceCriteria={ticket.acceptanceCriteria ?? []}
                  specSeverity={latestSpecReview?.severity ?? "none"} codeSeverity={worstCodeSeverity}
                  allIssuesResolved={(ctx.outputMaybe("review_fix", { nodeId: `${ticket.id}:review-fix` }) as any)?.allIssuesResolved ?? true}
                  reviewRounds={1}
                  goTests={latestTest?.goTestsPassed ? "PASS" : "FAIL"}
                  rustTests={latestTest?.rustTestsPassed ? "PASS" : "FAIL"}
                  e2eTests={latestTest?.e2eTestsPassed ? "PASS" : "FAIL"}
                  sqlcGen={latestTest?.sqlcGenPassed ? "PASS" : "FAIL"}
                />
              </Task>
            );
          default:
            return null;
        }
      })();

      if (!taskElement) return null;
      return wrapWorktree(ticket.id, taskElement);
    }
  }
}
