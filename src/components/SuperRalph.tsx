import { Ralph, Parallel, Sequence, Worktree, Task } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";
import { selectAllTickets, selectReviewTickets, selectProgressSummary, selectImplement, selectTestResults, selectSpecReview, selectCodeReviews, selectResearch, selectPlan, selectTicketReport } from "../selectors";
import type { RalphOutputs, Ticket } from "../selectors";
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

  // Agents (grouped) - each can be a single agent or [agent, fallback]
  agents: {
    planning: any | [any, any];
    implementation: any | [any, any];
    testing: any | [any, any];
    reviewing: any | [any, any];
    reporting: any | [any, any];
  };

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

  // Specs as children
  children?: ReactNode;
};

function normalizeAgent(agentOrArray: any | any[]): any | any[] {
  return agentOrArray; // Just return as-is, Task handles arrays now
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
  agents,
  progressFile = "PROGRESS.md",
  findingsFile = "docs/test-suite-findings.md",
  commitConfig = {},
  testSuites = [],
  focusTestSuites = {},
  focusDirs = {},
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

  children,
}: SuperRalphProps) {
  const { findings: reviewFindings } = selectReviewTickets(ctx, focuses, outputs);
  const { completed: completedTicketIds, unfinished: unfinishedTickets } = selectAllTickets(ctx, focuses, outputs);
  const progressSummary = selectProgressSummary(ctx, outputs);

  const { prefix = "📝", mainBranch = "main", emojiPrefixes = "✨ feat, 🐛 fix, ♻️ refactor, 📝 docs, 🧪 test" } = commitConfig;

  const planningAgent = normalizeAgent(agents.planning);
  const implementationAgent = normalizeAgent(agents.implementation);
  const testingAgent = normalizeAgent(agents.testing);
  const reviewingAgent = normalizeAgent(agents.reviewing);
  const reportingAgent = normalizeAgent(agents.reporting);

  return (
    <Ralph until={false} maxIterations={Infinity} onMaxReached="return-last">
      <Parallel maxConcurrency={maxConcurrency}>
        {!skipPhases.has("PROGRESS") && (customUpdateProgress || (
          <Task id="update-progress" output={outputs.progress} agent={reportingAgent} retries={taskRetries}>
            <UpdateProgressPrompt
              projectName={projectName}
              progressFile={progressFile}
              commitMessage={`${prefix} docs: update progress`}
              completedTickets={completedTicketIds}
            />
          </Task>
        ))}

        {!skipPhases.has("CODEBASE_REVIEW") && (customCategoryReview ? (
          customCategoryReview
        ) : (
          <Parallel maxConcurrency={maxConcurrency}>
            {focuses.map(({ id, name }) => (
              <Task key={id} id={`codebase-review:${id}`} output={outputs.category_review} agent={reviewingAgent} retries={taskRetries}>
                <CategoryReviewPrompt categoryId={id} categoryName={name} relevantDirs={focusDirs[id] ?? null} />
              </Task>
            ))}
          </Parallel>
        ))}

        {!skipPhases.has("DISCOVER") && (customDiscover || (
          <Task id="discover" output={outputs.discover} agent={planningAgent} retries={taskRetries}>
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
        ))}

        {!skipPhases.has("INTEGRATION_TEST") && (customIntegrationTest || (
          <Parallel maxConcurrency={maxConcurrency}>
            {focuses.map(({ id, name }) => {
              const suiteInfo = focusTestSuites[id] ?? { suites: [], setupHints: [], testDirs: [] };
              return (
                <Task key={id} id={`integration-test:${id}`} output={outputs.integration_test} agent={testingAgent} retries={taskRetries}>
                  <IntegrationTestPrompt
                    categoryId={id}
                    categoryName={name}
                    suites={suiteInfo.suites}
                    setupHints={suiteInfo.setupHints}
                    testDirs={suiteInfo.testDirs}
                    findingsFile={findingsFile}
                  />
                </Task>
              );
            })}
          </Parallel>
        ))}

        {unfinishedTickets.map((ticket: Ticket) => {
          const researchData = selectResearch(ctx, ticket.id, outputs);
          const planData = selectPlan(ctx, ticket.id, outputs);
          const contextFilePath = researchData?.contextFilePath ?? `docs/context/${ticket.id}.md`;
          const planFilePath = planData?.planFilePath ?? `docs/plans/${ticket.id}.md`;

          return (
            <Worktree key={ticket.id} id={`wt-${ticket.id}`} path={`/tmp/workflow-wt-${ticket.id}`}>
              <Sequence skipIf={selectTicketReport(ctx, ticket.id, outputs)?.status === "complete"}>
                {customResearch || (
                  <Task id={`${ticket.id}:research`} output={outputs.research} agent={planningAgent} retries={taskRetries}>
                    <ResearchPrompt
                      ticketId={ticket.id}
                      ticketTitle={ticket.title}
                      ticketDescription={ticket.description}
                      ticketCategory={ticket.category}
                      referenceFiles={ticket.referenceFiles}
                      relevantFiles={ticket.relevantFiles}
                      contextFilePath={contextFilePath}
                      referencePaths={[specsPath, ...referenceFiles]}
                    />
                  </Task>
                )}

                {customPlan || (
                  <Task id={`${ticket.id}:plan`} output={outputs.plan} agent={planningAgent} retries={taskRetries}>
                    <PlanPrompt
                      ticketId={ticket.id}
                      ticketTitle={ticket.title}
                      ticketDescription={ticket.description}
                      ticketCategory={ticket.category}
                      acceptanceCriteria={ticket.acceptanceCriteria ?? []}
                      contextFilePath={contextFilePath}
                      researchSummary={researchData?.summary ?? null}
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
                    const latestImplement = selectImplement(ctx, ticket.id, outputs);
                    const latestTest = selectTestResults(ctx, ticket.id, outputs);
                    const latestSpecReview = selectSpecReview(ctx, ticket.id, outputs);
                    const { worstSeverity: worstCodeSeverity, mergedIssues: mergedCodeIssues, mergedFeedback: mergedCodeFeedback } = selectCodeReviews(ctx, ticket.id, outputs);

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
                          <Task id={`${ticket.id}:implement`} output={outputs.implement} agent={implementationAgent} retries={taskRetries}>
                            <ImplementPrompt
                              ticketId={ticket.id}
                              ticketTitle={ticket.title}
                              ticketCategory={ticket.category}
                              planFilePath={planFilePath}
                              contextFilePath={contextFilePath}
                              implementationSteps={planData?.implementationSteps ?? null}
                              previousImplementation={latestImplement ?? null}
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
                          <Task id={`${ticket.id}:test`} output={outputs.test_results} agent={testingAgent} retries={taskRetries}>
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
                          <Task id={`${ticket.id}:build-verify`} output={outputs.build_verify} agent={testingAgent} retries={taskRetries}>
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
                            <Task id={`${ticket.id}:spec-review`} output={outputs.spec_review} agent={reviewingAgent} retries={taskRetries}>
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
                            <Task id={`${ticket.id}:code-review`} output={outputs.code_review} agent={reviewingAgent} retries={taskRetries}>
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
                          <Task id={`${ticket.id}:review-fix`} output={outputs.review_fix} agent={implementationAgent} retries={taskRetries}>
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
                  <Task id={`${ticket.id}:report`} output={outputs.report} agent={reportingAgent} retries={taskRetries}>
                    <ReportPrompt
                      ticketId={ticket.id}
                      ticketTitle={ticket.title}
                      ticketCategory={ticket.category}
                      acceptanceCriteria={ticket.acceptanceCriteria ?? []}
                      specSeverity={selectSpecReview(ctx, ticket.id, outputs)?.severity ?? "none"}
                      codeSeverity={selectCodeReviews(ctx, ticket.id, outputs).worstSeverity}
                      allIssuesResolved={(ctx.outputMaybe("review_fix", { nodeId: `${ticket.id}:review-fix` }) as any)?.allIssuesResolved ?? true}
                      reviewRounds={1}
                      goTests={selectTestResults(ctx, ticket.id, outputs)?.goTestsPassed ? "PASS" : "FAIL"}
                      rustTests={selectTestResults(ctx, ticket.id, outputs)?.rustTestsPassed ? "PASS" : "FAIL"}
                      e2eTests={selectTestResults(ctx, ticket.id, outputs)?.e2eTestsPassed ? "PASS" : "FAIL"}
                      sqlcGen={selectTestResults(ctx, ticket.id, outputs)?.sqlcGenPassed ? "PASS" : "FAIL"}
                    />
                  </Task>
                )}
              </Sequence>
            </Worktree>
          );
        })}
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
