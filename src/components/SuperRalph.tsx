import { Ralph, Parallel, Worktree, Task } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";
import { selectAllTickets, selectReviewTickets, selectProgressSummary } from "../selectors";
import type { SuperRalphContext } from "../hooks/useSuperRalph";
import React from "react";
import UpdateProgressPrompt from "../prompts/UpdateProgress.mdx";
import DiscoverPrompt from "../prompts/Discover.mdx";
import IntegrationTestPrompt from "../prompts/IntegrationTest.mdx";

// Child component types
type UpdateProgressProps = {
  agent: any;
  fallbackAgent: any;
  projectName: string;
  progressFile: string;
  commitMessage?: string;
};

type DiscoverProps = {
  agent: any;
  fallbackAgent: any;
};

type IntegrationTestProps = {
  agent: any;
  fallbackAgent: any;
  categoryTestSuites: Record<string, { suites: string[]; setupHints: string[]; testDirs: string[] }>;
  findingsFile: string;
};

type CodebaseReviewProps = {
  children: React.ReactElement;
};

type TicketPipelineProps = {
  children: React.ReactElement;
};

// Main component props
export type SuperRalphProps = {
  superRalphCtx: SuperRalphContext;
  ctx: SmithersCtx<any>;
  maxConcurrency: number;
  taskRetries: number;
  categories: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  outputs: any;
  target: any;
  skipPhases?: Set<string>;
  children: React.ReactNode;
};

export function SuperRalph({
  superRalphCtx,
  ctx,
  maxConcurrency,
  taskRetries,
  categories,
  outputs,
  target,
  skipPhases = new Set(),
  children,
}: SuperRalphProps) {
  const { completedTicketIds, unfinishedTickets, reviewFindings, progressSummary } = superRalphCtx;

  // Extract child components from children
  const childArray = React.Children.toArray(children);
  const updateProgress = childArray.find((c: any) => c?.type === UpdateProgress) as any;
  const discover = childArray.find((c: any) => c?.type === Discover) as any;
  const integrationTest = childArray.find((c: any) => c?.type === IntegrationTest) as any;
  const codebaseReview = childArray.find((c: any) => c?.type === CodebaseReview) as any;
  const ticketPipeline = childArray.find((c: any) => c?.type === TicketPipeline) as any;

  return (
    <Ralph until={false} maxIterations={Infinity} onMaxReached="return-last">
      <Parallel maxConcurrency={maxConcurrency}>
        {!skipPhases.has("PROGRESS") && updateProgress && (
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

        {!skipPhases.has("CODEBASE_REVIEW") && codebaseReview && codebaseReview.props.children}

        {!skipPhases.has("DISCOVER") && discover && (
          <Task
            id="discover"
            output={outputs.discover}
            agent={discover.props.agent}
            fallbackAgent={discover.props.fallbackAgent}
            retries={taskRetries}
          >
            <DiscoverPrompt
              projectName={updateProgress?.props.projectName ?? "Project"}
              specsPath={target.specsPath}
              referenceFiles={target.referenceFiles}
              categories={categories}
              completedTicketIds={completedTicketIds}
              previousProgress={progressSummary}
              reviewFindings={reviewFindings}
            />
          </Task>
        )}

        {!skipPhases.has("INTEGRATION_TEST") && integrationTest && (
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
            {ticketPipeline && React.cloneElement(ticketPipeline.props.children, { target, ticket, ctx })}
          </Worktree>
        ))}
      </Parallel>
    </Ralph>
  );
}

// Compound components
function UpdateProgress(_props: UpdateProgressProps) {
  return null;
}

function Discover(_props: DiscoverProps) {
  return null;
}

function IntegrationTest(_props: IntegrationTestProps) {
  return null;
}

function CodebaseReview(_props: CodebaseReviewProps) {
  return null;
}

function TicketPipeline(_props: TicketPipelineProps) {
  return null;
}

SuperRalph.UpdateProgress = UpdateProgress;
SuperRalph.Discover = Discover;
SuperRalph.IntegrationTest = IntegrationTest;
SuperRalph.CodebaseReview = CodebaseReview;
SuperRalph.TicketPipeline = TicketPipeline;
