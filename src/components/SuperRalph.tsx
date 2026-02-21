import { Ralph, Parallel, Worktree, Task } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";
import { selectAllTickets, selectReviewTickets, selectProgressSummary } from "../selectors";
import type { SuperRalphContext } from "../hooks/useSuperRalph";
import { useSuperRalph } from "../hooks/useSuperRalph";
import React from "react";

export type SuperRalphPrompts = {
  UpdateProgress: React.ComponentType<{ completedTickets: string[] }>;
  Discover: React.ComponentType<{ categories: any[]; completedTicketIds: string[]; previousProgress: string | null; reviewFindings: string | null }>;
  Research: React.ComponentType<any>;
  Plan: React.ComponentType<any>;
  Implement: React.ComponentType<any>;
  Test: React.ComponentType<any>;
  BuildVerify: React.ComponentType<any>;
  SpecReview: React.ComponentType<any>;
  ReviewFix: React.ComponentType<any>;
  Report: React.ComponentType<any>;
  CategoryReview: React.ComponentType<any>;
  CodeReview: React.ComponentType<any>;
  IntegrationTest: React.ComponentType<any>;
};

export type SuperRalphAgents = {
  updateProgress: { agent: any; fallback: any };
  discover: { agent: any; fallback: any };
  research: { agent: any; fallback: any };
  plan: { agent: any; fallback: any };
  implement: { agent: any; fallback: any };
  test: { agent: any; fallback: any };
  buildVerify: { agent: any; fallback: any };
  specReview: { agent: any; fallback: any };
  reviewFix: { agent: any; fallback: any };
  report: { agent: any; fallback: any };
  categoryReview: { agent: any; fallback?: any };
  codeReview: { claude: any; codex: any; gemini: any; fallbacks: { claude: any; codex: any; gemini: any } };
  integrationTest: { agent: any; fallback: any };
};

export type SuperRalphConfig = {
  name: string;
  maxConcurrency: number;
  taskRetries: number;
  categories: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  outputs: any; // Smithers outputs object
  categoryReferencePaths: Record<string, string[]>;
  CodebaseReview: React.ComponentType<{ target: any }>;
  TicketPipeline: React.ComponentType<{ target: any; ticket: any; ctx: SmithersCtx<any> }>;
  IntegrationTest: React.ComponentType<{ target: any }>;
  target: any; // Project-specific target config (build cmds, test cmds, code style, etc.)
};

export type SuperRalphProps = {
  ctx?: SmithersCtx<any>;
  superRalphCtx?: SuperRalphContext;
  prompts: SuperRalphPrompts;
  agents: SuperRalphAgents;
  config: SuperRalphConfig;
  skipPhases?: Set<string>;
};

export function SuperRalph({ ctx, superRalphCtx, prompts, agents, config, skipPhases = new Set() }: SuperRalphProps) {
  // Controlled component: use provided superRalphCtx, or compute it from ctx
  const workflowState = superRalphCtx ?? (ctx ? useSuperRalph(ctx, { categories: config.categories, outputs: config.outputs }) : null);

  if (!workflowState) {
    throw new Error("SuperRalph requires either ctx or superRalphCtx prop");
  }

  const { completedTicketIds, unfinishedTickets, reviewFindings } = workflowState;
  const { UpdateProgress, Discover } = prompts;
  const { CodebaseReview, TicketPipeline, IntegrationTest, target } = config;

  return (
    <Ralph until={false} maxIterations={Infinity} onMaxReached="return-last">
      <Parallel maxConcurrency={config.maxConcurrency}>
        {!skipPhases.has("PROGRESS") && (
          <Task
            id="update-progress"
            output={config.outputs.progress}
            agent={agents.updateProgress.agent}
            fallbackAgent={agents.updateProgress.fallback}
            retries={config.taskRetries}
          >
            <UpdateProgress completedTickets={completedTicketIds} />
          </Task>
        )}

        {!skipPhases.has("CODEBASE_REVIEW") && <CodebaseReview target={target} />}

        {!skipPhases.has("DISCOVER") && (
          <Task
            id="discover"
            output={config.outputs.discover}
            agent={agents.discover.agent}
            fallbackAgent={agents.discover.fallback}
            retries={config.taskRetries}
          >
            <Discover
              categories={config.categories}
              completedTicketIds={completedTicketIds}
              previousProgress={workflowState.progressSummary}
              reviewFindings={reviewFindings}
            />
          </Task>
        )}

        {!skipPhases.has("INTEGRATION_TEST") && <IntegrationTest target={target} />}

        {unfinishedTickets.map((ticket: any) => (
          <Worktree key={ticket.id} id={`wt-${ticket.id}`} path={`/tmp/workflow-wt-${ticket.id}`}>
            <TicketPipeline target={target} ticket={ticket} ctx={ctx!} />
          </Worktree>
        ))}
      </Parallel>
    </Ralph>
  );
}
