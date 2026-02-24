import { Database } from "bun:sqlite";

/**
 * Tracks currently scheduled/running jobs in SQLite.
 * Jobs are inserted when the scheduler enqueues them and removed when they complete.
 * Covers ALL job types: ticket pipeline steps, discovery, progress, codebase reviews, etc.
 */

export type ScheduledJob = {
  jobId: string;
  jobType: string;
  agentId: string;
  ticketId: string | null;
  focusId: string | null;
  createdAtMs: number;
};

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS scheduled_tasks (
  job_id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  ticket_id TEXT,
  focus_id TEXT,
  created_at_ms INTEGER NOT NULL
)`;

export function ensureTable(db: Database): void {
  db.exec(CREATE_TABLE);
}

export function insertJob(db: Database, job: ScheduledJob): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_tasks (job_id, job_type, agent_id, ticket_id, focus_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(job.jobId, job.jobType, job.agentId, job.ticketId, job.focusId, job.createdAtMs);
}

export function removeJob(db: Database, jobId: string): void {
  db.prepare(`DELETE FROM scheduled_tasks WHERE job_id = ?`).run(jobId);
}

export function getActiveJobs(db: Database): ScheduledJob[] {
  return db.prepare(
    `SELECT job_id as jobId, job_type as jobType, agent_id as agentId, ticket_id as ticketId, focus_id as focusId, created_at_ms as createdAtMs FROM scheduled_tasks ORDER BY created_at_ms ASC`
  ).all() as ScheduledJob[];
}

export function getActiveJobCount(db: Database): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM scheduled_tasks`).get() as { count: number };
  return row.count;
}
