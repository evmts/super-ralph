import { Database } from "bun:sqlite";

export type CrossRunTicketState = {
  ticketId: string;
  latestRunId: string;
  pipelineStage: string;
  landed: boolean;
  iteration: number;
};

/**
 * Query the SQLite database directly to find ticket state across ALL runs.
 * Returns the most advanced pipeline stage for each ticket across any run.
 */
export function loadCrossRunTicketState(dbPath: string): CrossRunTicketState[] {
  const db = new Database(dbPath, { readonly: true });

  const stages = [
    { table: "land", suffix: "land", stage: "land" },
    { table: "report", suffix: "report", stage: "report" },
    { table: "review_fix", suffix: "review-fix", stage: "review_fix" },
    { table: "code_review", suffix: "code-review", stage: "code_review" },
    { table: "spec_review", suffix: "spec-review", stage: "spec_review" },
    { table: "build_verify", suffix: "build-verify", stage: "build_verify" },
    { table: "test_results", suffix: "test", stage: "test" },
    { table: "implement", suffix: "implement", stage: "implement" },
    { table: "plan", suffix: "plan", stage: "plan" },
    { table: "research", suffix: "research", stage: "research" },
  ];

  const ticketStages = new Map<string, CrossRunTicketState>();

  for (const { table, suffix, stage } of stages) {
    try {
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table);
      if (!tableExists) continue;

      const rows = db.prepare(
        `SELECT DISTINCT node_id, run_id, MAX(iteration) as iteration FROM "${table}" GROUP BY node_id`
      ).all() as Array<{ node_id: string; run_id: string; iteration: number }>;

      for (const row of rows) {
        const ticketId = row.node_id.replace(`:${suffix}`, "");
        if (ticketId === row.node_id && suffix !== "land") continue;

        if (!ticketStages.has(ticketId)) {
          let actuallyLanded = false;
          if (stage === "land") {
            try {
              const landRow = db.prepare(
                `SELECT merged FROM land WHERE node_id = ? ORDER BY iteration DESC LIMIT 1`
              ).get(row.node_id) as { merged: number } | undefined;
              actuallyLanded = landRow?.merged === 1;
            } catch {}
          }

          ticketStages.set(ticketId, {
            ticketId,
            latestRunId: row.run_id,
            pipelineStage: stage,
            landed: actuallyLanded,
            iteration: row.iteration,
          });
        }
      }
    } catch {
      // Table doesn't exist or query error, skip
    }
  }

  db.close();
  return Array.from(ticketStages.values());
}

/**
 * Get tickets that were in-progress in previous runs but haven't been landed.
 * These should be resumed before discovering new tickets.
 */
export function getResumableTickets(dbPath: string, currentRunId: string): CrossRunTicketState[] {
  const allState = loadCrossRunTicketState(dbPath);
  return allState.filter(t =>
    !t.landed &&
    t.latestRunId !== currentRunId &&
    t.pipelineStage !== "not_started"
  );
}

/**
 * Get the furthest pipeline stage index for sorting.
 * Higher = further along = should be prioritized.
 */
export function pipelineStageIndex(stage: string): number {
  const order = ["not_started", "research", "plan", "implement", "test", "build_verify", "spec_review", "code_review", "review_fix", "report", "land"];
  return order.indexOf(stage);
}
