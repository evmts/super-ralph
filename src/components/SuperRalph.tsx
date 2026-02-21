import { Ralph, Parallel, Sequence, Worktree, Task } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";
import { selectAllTickets, selectImplement, selectTestResults, selectSpecReview, selectCodeReviews } from "../selectors";
import type { SuperRalphContext } from "../hooks/useSuperRalph";
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

// ============================================================================
// COMPOUND COMPONENT PROP TYPES
// ============================================================================

type UpdateProgressProps = {
  agent: any;
  fallbackAgent?: any;
  projectName: string;
  progressFile: string;
  commitMessage?: string;
};

type DiscoverProps = {
  agent: any;
  fallbackAgent?: any;
  specsPath: string;
  referenceFiles: string[];
};

type IntegrationTestProps = {
  agent: any;
  fallbackAgent?: any;
  categories: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  categoryTestSuites: Record<string, { suites: string[]; setupHints: string[]; testDirs: string[] }>;
  findingsFile: string;
};

type CategoryReviewProps = {
  agent: any;
  fallbackAgent?: any;
  categoryDirs?: Record<string, string[]>;
};

type ResearchProps = {
  agent: any;
  fallbackAgent?: any;
  contextDir?: string;
  referencePaths?: string[];
};

type PlanProps = {
  agent: any;
  fallbackAgent?: any;
  planDir?: string;
  tddPatterns?: string[];
  commitPrefix?: string;
  mainBranch?: string;
};

type ImplementProps = {
  agent: any;
  fallbackAgent?: any;
  testWritingGuidance?: string[];
  implementationGuidance?: string[];
  formatterCommands?: string[];
  verifyCommands?: string[];
  architectureRules?: string[];
  commitPrefix?: string;
  mainBranch?: string;
  emojiPrefixes?: string;
};

type TestProps = {
  agent: any;
  fallbackAgent?: any;
  testSuites?: Array<{
    name: string;
    command: string;
    description: string;
    skipCondition?: string;
    skipNote?: string;
  }>;
  fixCommitPrefix?: string;
  mainBranch?: string;
};

type BuildVerifyProps = {
  agent: any;
  fallbackAgent?: any;
  buildCommand?: string;
  verifyCommands?: string[];
};

type SpecReviewProps = {
  agent: any;
  fallbackAgent?: any;
  specChecks?: Array<{ name: string; items: string[] }>;
  testResults?: Array<{ name: string; status: string }>;
};

type CodeReviewProps = {
  agent: any;
  fallbackAgent?: any;
  additionalAgents?: Array<{ agent: any; fallbackAgent?: any; outputKey: string }>;
  reviewChecklist?: string[];
};

type ReviewFixProps = {
  agent: any;
  fallbackAgent?: any;
  validationCommands?: string[];
  commitPrefix?: string;
  mainBranch?: string;
  emojiPrefixes?: string;
};

type ReportProps = {
  agent: any;
  fallbackAgent?: any;
  reportDir?: string;
};

// ============================================================================
// MAIN COMPONENT PROPS
// ============================================================================

export type SuperRalphProps = {
  superRalphCtx: SuperRalphContext;
  maxConcurrency: number;
  taskRetries: number;
  skipPhases?: Set<string>;
  updateProgress: ReactElement<UpdateProgressProps>;
  discover: ReactElement<DiscoverProps>;
  integrationTest: ReactElement<IntegrationTestProps>;
  categoryReview: ReactElement<CategoryReviewProps>;
  research: ReactElement<ResearchProps>;
  plan: ReactElement<PlanProps>;
  implement: ReactElement<ImplementProps>;
  test: ReactElement<TestProps>;
  buildVerify: ReactElement<BuildVerifyProps>;
  specReview: ReactElement<SpecReviewProps>;
  codeReview: ReactElement<CodeReviewProps>;
  reviewFix: ReactElement<ReviewFixProps>;
  report: ReactElement<ReportProps>;
};

// ============================================================================
// ORCHESTRATORS (BUILT-IN)
// ============================================================================

type ValidationLoopProps = {
  ticket: any;
  planFilePath: string;
  contextFilePath: string;
  implementationSteps: string[] | null;
  ctx: SmithersCtx<any>;
  maxConcurrency: number;
  taskRetries: number;
  implement: ReactElement<ImplementProps>;
  test: ReactElement<TestProps>;
  buildVerify: ReactElement<BuildVerifyProps>;
  specReview: ReactElement<SpecReviewProps>;
  codeReview: ReactElement<CodeReviewProps>;
  reviewFix: ReactElement<ReviewFixProps>;
  outputs: any;
};

function ValidationLoop({
  ticket,
  planFilePath,
  contextFilePath,
  implementationSteps,
  ctx,
  maxConcurrency,
  taskRetries,
  implement,
  test,
  buildVerify,
  specReview,
  codeReview,
  reviewFix,
  outputs,
}: ValidationLoopProps) {
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

  const testResults = latestTest ? [
    { name: "Go Tests", status: latestTest.goTestsPassed ? "PASS" : "FAIL" },
    { name: "Rust Tests", status: latestTest.rustTestsPassed ? "PASS" : "FAIL" },
    { name: "E2E Tests", status: latestTest.e2eTestsPassed ? "PASS" : "FAIL" },
    { name: "SQLC Gen", status: latestTest.sqlcGenPassed ? "PASS" : "FAIL" },
  ] : [];

  // Extract additional code review agents
  const additionalCodeReviewAgents = codeReview.props.additionalAgents ?? [];

  return (
    <Sequence>
      <Task
        id={`${ticket.id}:implement`}
        output={outputs.implement}
        agent={implement.props.agent}
        fallbackAgent={implement.props.fallbackAgent}
        retries={taskRetries}
      >
        <ImplementPrompt
          ticketId={ticket.id}
          ticketTitle={ticket.title}
          ticketCategory={ticket.category}
          planFilePath={planFilePath}
          contextFilePath={contextFilePath}
          implementationSteps={implementationSteps}
          previousImplementation={latestImplement ?? null}
          reviewFeedback={reviewFeedback}
          failingTests={latestTest?.failingSummary ?? null}
          testWritingGuidance={implement.props.testWritingGuidance}
          implementationGuidance={implement.props.implementationGuidance}
          formatterCommands={implement.props.formatterCommands}
          verifyCommands={implement.props.verifyCommands}
          architectureRules={implement.props.architectureRules}
          commitPrefix={implement.props.commitPrefix}
          mainBranch={implement.props.mainBranch}
          emojiPrefixes={implement.props.emojiPrefixes}
        />
      </Task>

      <Task
        id={`${ticket.id}:test`}
        output={outputs.test_results}
        agent={test.props.agent}
        fallbackAgent={test.props.fallbackAgent}
        retries={taskRetries}
      >
        <TestPrompt
          ticketId={ticket.id}
          ticketTitle={ticket.title}
          ticketCategory={ticket.category}
          testSuites={test.props.testSuites}
          fixCommitPrefix={test.props.fixCommitPrefix}
          mainBranch={test.props.mainBranch}
        />
      </Task>

      <Task
        id={`${ticket.id}:build-verify`}
        output={outputs.build_verify}
        agent={buildVerify.props.agent}
        fallbackAgent={buildVerify.props.fallbackAgent}
        retries={taskRetries}
      >
        <BuildVerifyPrompt
          ticketId={ticket.id}
          ticketTitle={ticket.title}
          ticketCategory={ticket.category}
          filesCreated={latestImplement?.filesCreated ?? null}
          filesModified={latestImplement?.filesModified ?? null}
          whatWasDone={latestImplement?.whatWasDone ?? null}
        />
      </Task>

      <Parallel maxConcurrency={maxConcurrency}>
        <Task
          id={`${ticket.id}:spec-review`}
          output={outputs.spec_review}
          agent={specReview.props.agent}
          fallbackAgent={specReview.props.fallbackAgent}
          retries={taskRetries}
        >
          <SpecReviewPrompt
            ticketId={ticket.id}
            ticketTitle={ticket.title}
            ticketCategory={ticket.category}
            filesCreated={latestImplement?.filesCreated ?? null}
            filesModified={latestImplement?.filesModified ?? null}
            testResults={specReview.props.testResults ?? testResults}
            failingSummary={latestTest?.failingSummary ?? null}
            specChecks={specReview.props.specChecks}
          />
        </Task>

        <Task
          id={`${ticket.id}:code-review`}
          output={outputs.code_review}
          agent={codeReview.props.agent}
          fallbackAgent={codeReview.props.fallbackAgent}
          retries={taskRetries}
        >
          <CodeReviewPrompt
            ticketId={ticket.id}
            ticketTitle={ticket.title}
            ticketCategory={ticket.category}
            filesCreated={latestImplement?.filesCreated ?? null}
            filesModified={latestImplement?.filesModified ?? null}
            reviewChecklist={codeReview.props.reviewChecklist}
          />
        </Task>

        {additionalCodeReviewAgents.map(({ agent, fallbackAgent, outputKey }, idx) => (
          <Task
            key={`${ticket.id}:code-review-${idx}`}
            id={`${ticket.id}:code-review-${outputKey}`}
            output={outputs[outputKey]}
            agent={agent}
            fallbackAgent={fallbackAgent}
            retries={taskRetries}
          >
            <CodeReviewPrompt
              ticketId={ticket.id}
              ticketTitle={ticket.title}
              ticketCategory={ticket.category}
              filesCreated={latestImplement?.filesCreated ?? null}
              filesModified={latestImplement?.filesModified ?? null}
              reviewChecklist={codeReview.props.reviewChecklist}
            />
          </Task>
        ))}
      </Parallel>

      <Task
        id={`${ticket.id}:review-fix`}
        output={outputs.review_fix}
        agent={reviewFix.props.agent}
        fallbackAgent={reviewFix.props.fallbackAgent}
        retries={taskRetries}
        skipIf={noReviewIssues}
      >
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
          validationCommands={reviewFix.props.validationCommands}
          commitPrefix={reviewFix.props.commitPrefix}
          mainBranch={reviewFix.props.mainBranch}
          emojiPrefixes={reviewFix.props.emojiPrefixes}
        />
      </Task>
    </Sequence>
  );
}

type TicketPipelineProps = {
  ticket: any;
  ctx: SmithersCtx<any>;
  taskRetries: number;
  maxConcurrency: number;
  research: ReactElement<ResearchProps>;
  plan: ReactElement<PlanProps>;
  implement: ReactElement<ImplementProps>;
  test: ReactElement<TestProps>;
  buildVerify: ReactElement<BuildVerifyProps>;
  specReview: ReactElement<SpecReviewProps>;
  codeReview: ReactElement<CodeReviewProps>;
  reviewFix: ReactElement<ReviewFixProps>;
  report: ReactElement<ReportProps>;
  outputs: any;
};

function TicketPipeline({
  ticket,
  ctx,
  taskRetries,
  maxConcurrency,
  research,
  plan,
  implement,
  test,
  buildVerify,
  specReview,
  codeReview,
  reviewFix,
  report,
  outputs,
}: TicketPipelineProps) {
  const ticketReport = ctx.outputMaybe(outputs.report, { nodeId: `${ticket.id}:report` });
  const ticketComplete = ticketReport?.status === "complete";

  const researchData = ctx.outputMaybe(outputs.research, { nodeId: `${ticket.id}:research` });
  const planData = ctx.outputMaybe(outputs.plan, { nodeId: `${ticket.id}:plan` });
  const specReviewData = ctx.outputMaybe(outputs.spec_review, { nodeId: `${ticket.id}:spec-review` });
  const { worstSeverity: worstCodeSeverity } = selectCodeReviews(ctx, ticket.id);
  const testData = selectTestResults(ctx, ticket.id);
  const reviewFixData = ctx.outputMaybe(outputs.review_fix, { nodeId: `${ticket.id}:review-fix` });

  const reviewRounds = specReviewData ? 1 : 0;

  const contextDir = research.props.contextDir ?? "docs/context";
  const contextFilePath = researchData?.contextFilePath ?? `${contextDir}/${ticket.id}.md`;

  const planDir = plan.props.planDir ?? "docs/plans";
  const planFilePath = planData?.planFilePath ?? `${planDir}/${ticket.id}.md`;

  return (
    <Sequence skipIf={ticketComplete}>
      <Task
        id={`${ticket.id}:research`}
        output={outputs.research}
        agent={research.props.agent}
        fallbackAgent={research.props.fallbackAgent}
        retries={taskRetries}
      >
        <ResearchPrompt
          ticketId={ticket.id}
          ticketTitle={ticket.title}
          ticketDescription={ticket.description}
          ticketCategory={ticket.category}
          referenceFiles={ticket.referenceFiles}
          relevantFiles={ticket.relevantFiles}
          contextFilePath={contextFilePath}
          referencePaths={research.props.referencePaths ?? []}
        />
      </Task>

      <Task
        id={`${ticket.id}:plan`}
        output={outputs.plan}
        agent={plan.props.agent}
        fallbackAgent={plan.props.fallbackAgent}
        retries={taskRetries}
      >
        <PlanPrompt
          ticketId={ticket.id}
          ticketTitle={ticket.title}
          ticketDescription={ticket.description}
          ticketCategory={ticket.category}
          acceptanceCriteria={ticket.acceptanceCriteria ?? []}
          contextFilePath={contextFilePath}
          researchSummary={researchData?.summary ?? null}
          planFilePath={planFilePath}
          tddPatterns={plan.props.tddPatterns}
          commitPrefix={plan.props.commitPrefix}
          mainBranch={plan.props.mainBranch}
        />
      </Task>

      <ValidationLoop
        ticket={ticket}
        planFilePath={planFilePath}
        contextFilePath={contextFilePath}
        implementationSteps={planData?.implementationSteps ?? null}
        ctx={ctx}
        maxConcurrency={maxConcurrency}
        taskRetries={taskRetries}
        implement={implement}
        test={test}
        buildVerify={buildVerify}
        specReview={specReview}
        codeReview={codeReview}
        reviewFix={reviewFix}
        outputs={outputs}
      />

      <Task
        id={`${ticket.id}:report`}
        output={outputs.report}
        agent={report.props.agent}
        fallbackAgent={report.props.fallbackAgent}
        retries={taskRetries}
      >
        <ReportPrompt
          ticketId={ticket.id}
          ticketTitle={ticket.title}
          ticketCategory={ticket.category}
          acceptanceCriteria={ticket.acceptanceCriteria ?? []}
          specSeverity={specReviewData?.severity ?? "none"}
          codeSeverity={worstCodeSeverity}
          allIssuesResolved={reviewFixData?.allIssuesResolved ?? true}
          reviewRounds={reviewRounds}
          goTests={testData?.goTestsPassed ? "PASS" : "FAIL"}
          rustTests={testData?.rustTestsPassed ? "PASS" : "FAIL"}
          e2eTests={testData?.e2eTestsPassed ? "PASS" : "FAIL"}
          sqlcGen={testData?.sqlcGenPassed ? "PASS" : "FAIL"}
        />
      </Task>
    </Sequence>
  );
}

type CodebaseReviewOrchestratorProps = {
  categories: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  maxConcurrency: number;
  taskRetries: number;
  categoryReview: ReactElement<CategoryReviewProps>;
  outputs: any;
};

function CodebaseReviewOrchestrator({
  categories,
  maxConcurrency,
  taskRetries,
  categoryReview,
  outputs,
}: CodebaseReviewOrchestratorProps) {
  const categoryDirs = categoryReview.props.categoryDirs ?? {};

  return (
    <Parallel maxConcurrency={maxConcurrency}>
      {categories.map(({ id, name }) => (
        <Task
          key={id}
          id={`codebase-review:${id}`}
          output={outputs.category_review}
          agent={categoryReview.props.agent}
          fallbackAgent={categoryReview.props.fallbackAgent}
          retries={taskRetries}
        >
          <CategoryReviewPrompt
            categoryId={id}
            categoryName={name}
            relevantDirs={categoryDirs[id] ?? null}
          />
        </Task>
      ))}
    </Parallel>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function SuperRalph({
  superRalphCtx,
  maxConcurrency,
  taskRetries,
  skipPhases = new Set(),
  updateProgress,
  discover,
  integrationTest,
  categoryReview,
  research,
  plan,
  implement,
  test,
  buildVerify,
  specReview,
  codeReview,
  reviewFix,
  report,
}: SuperRalphProps) {
  const { ctx, completedTicketIds, unfinishedTickets, reviewFindings, progressSummary, categories, outputs } = superRalphCtx;

  return (
    <Ralph until={false} maxIterations={Infinity} onMaxReached="return-last">
      <Parallel maxConcurrency={maxConcurrency}>
        {!skipPhases.has("PROGRESS") && (
          <Task
            id="update-progress"
            output={outputs.progress}
            agent={updateProgress.props.agent}
            fallbackAgent={updateProgress.props.fallbackAgent}
            retries={taskRetries}
          >
            <UpdateProgressPrompt
              projectName={updateProgress.props.projectName}
              progressFile={updateProgress.props.progressFile}
              commitMessage={updateProgress.props.commitMessage}
              completedTickets={completedTicketIds}
            />
          </Task>
        )}

        {!skipPhases.has("CODEBASE_REVIEW") && (
          <CodebaseReviewOrchestrator
            categories={categories}
            maxConcurrency={maxConcurrency}
            taskRetries={taskRetries}
            categoryReview={categoryReview}
            outputs={outputs}
          />
        )}

        {!skipPhases.has("DISCOVER") && (
          <Task
            id="discover"
            output={outputs.discover}
            agent={discover.props.agent}
            fallbackAgent={discover.props.fallbackAgent}
            retries={taskRetries}
          >
            <DiscoverPrompt
              projectName={updateProgress.props.projectName}
              specsPath={discover.props.specsPath}
              referenceFiles={discover.props.referenceFiles}
              categories={categories}
              completedTicketIds={completedTicketIds}
              previousProgress={progressSummary}
              reviewFindings={reviewFindings}
            />
          </Task>
        )}

        {!skipPhases.has("INTEGRATION_TEST") && (
          <Parallel maxConcurrency={maxConcurrency}>
            {categories.map(({ id, name }) => {
              const suiteInfo = integrationTest.props.categoryTestSuites[id] ?? { suites: [], setupHints: [], testDirs: [] };
              return (
                <Task
                  key={id}
                  id={`integration-test:${id}`}
                  output={outputs.integration_test}
                  agent={integrationTest.props.agent}
                  fallbackAgent={integrationTest.props.fallbackAgent}
                  retries={taskRetries}
                >
                  <IntegrationTestPrompt
                    categoryId={id}
                    categoryName={name}
                    suites={suiteInfo.suites}
                    setupHints={suiteInfo.setupHints}
                    testDirs={suiteInfo.testDirs}
                    findingsFile={integrationTest.props.findingsFile}
                  />
                </Task>
              );
            })}
          </Parallel>
        )}

        {unfinishedTickets.map((ticket: any) => (
          <Worktree key={ticket.id} id={`wt-${ticket.id}`} path={`/tmp/workflow-wt-${ticket.id}`}>
            <TicketPipeline
              ticket={ticket}
              ctx={ctx}
              taskRetries={taskRetries}
              maxConcurrency={maxConcurrency}
              research={research}
              plan={plan}
              implement={implement}
              test={test}
              buildVerify={buildVerify}
              specReview={specReview}
              codeReview={codeReview}
              reviewFix={reviewFix}
              report={report}
              outputs={outputs}
            />
          </Worktree>
        ))}
      </Parallel>
    </Ralph>
  );
}

// ============================================================================
// COMPOUND COMPONENTS (MARKER COMPONENTS FOR TYPE SAFETY)
// ============================================================================

function UpdateProgress(_props: UpdateProgressProps) {
  return null;
}

function Discover(_props: DiscoverProps) {
  return null;
}

function IntegrationTest(_props: IntegrationTestProps) {
  return null;
}

function CategoryReview(_props: CategoryReviewProps) {
  return null;
}

function Research(_props: ResearchProps) {
  return null;
}

function Plan(_props: PlanProps) {
  return null;
}

function Implement(_props: ImplementProps) {
  return null;
}

function Test(_props: TestProps) {
  return null;
}

function BuildVerify(_props: BuildVerifyProps) {
  return null;
}

function SpecReview(_props: SpecReviewProps) {
  return null;
}

function CodeReview(_props: CodeReviewProps) {
  return null;
}

function ReviewFix(_props: ReviewFixProps) {
  return null;
}

function Report(_props: ReportProps) {
  return null;
}

SuperRalph.UpdateProgress = UpdateProgress;
SuperRalph.Discover = Discover;
SuperRalph.IntegrationTest = IntegrationTest;
SuperRalph.CategoryReview = CategoryReview;
SuperRalph.Research = Research;
SuperRalph.Plan = Plan;
SuperRalph.Implement = Implement;
SuperRalph.Test = Test;
SuperRalph.BuildVerify = BuildVerify;
SuperRalph.SpecReview = SpecReview;
SuperRalph.CodeReview = CodeReview;
SuperRalph.ReviewFix = ReviewFix;
SuperRalph.Report = Report;
