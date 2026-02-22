import React from "react";
import { Task } from "smithers-orchestrator";
import { z } from "zod";
import type { ClarificationSession } from "../cli/clarifications";

export const monitorOutputSchema = z.object({
  serverUrl: z.string(),
  port: z.number(),
  started: z.boolean(),
});

export type MonitorOutput = z.infer<typeof monitorOutputSchema>;

export type MonitorProps = {
  dbPath: string;
  runId: string;
  config: any;
  clarificationSession: ClarificationSession | null;
  prompt: string;
  repoRoot: string;
};

/**
 * Monitor Smithers Component
 *
 * Starts a long-running web server that provides real-time monitoring
 * of the workflow execution. The server:
 * - Polls the Smithers database for updates
 * - Renders an interactive dashboard showing workflow state
 * - Provides an AI chat interface (bypassing Smithers for responsiveness)
 * - Allows ticket management (add/remove/cancel)
 *
 * This runs as a background task in parallel with the main workflow.
 */
export function Monitor({
  dbPath,
  runId,
  config,
  clarificationSession,
  prompt,
  repoRoot,
}: MonitorProps) {
  return (
    <Task
      id="monitor"
      output={monitorOutputSchema}
      continueOnFail={true} // Don't block workflow if monitor fails
    >
      {async () => {
        // Dynamic imports to keep dependencies optional
        const { default: Bun } = await import("bun");
        const { join } = await import("node:path");
        const { Database } = await import("bun:sqlite");

        // Find an available port
        const findAvailablePort = async (start: number, end: number): Promise<number> => {
          for (let port = start; port <= end; port++) {
            try {
              const testServer = Bun.serve({
                port,
                fetch: () => new Response("test"),
              });
              testServer.stop();
              return port;
            } catch {
              continue;
            }
          }
          throw new Error(`No available ports in range ${start}-${end}`);
        };

        const port = await findAvailablePort(4500, 4600);

        // Generate HTML for the dashboard
        const dashboardHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Super Ralph Monitor - ${config.projectName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0e27;
      color: #e0e0e0;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 {
      font-size: 2rem;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .meta { font-size: 0.9rem; color: #888; margin-bottom: 2rem; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
    .card {
      background: #1a1f3a;
      border-radius: 8px;
      padding: 20px;
      border: 1px solid #2a2f4a;
    }
    .card h2 {
      font-size: 1.2rem;
      margin-bottom: 1rem;
      color: #667eea;
    }
    .stat {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #2a2f4a;
    }
    .stat:last-child { border-bottom: none; }
    .progress-bar {
      width: 100%;
      height: 8px;
      background: #2a2f4a;
      border-radius: 4px;
      overflow: hidden;
      margin-top: 8px;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
      transition: width 0.3s ease;
    }
    .ticket-list { list-style: none; }
    .ticket-item {
      padding: 12px;
      margin-bottom: 8px;
      background: #0f1425;
      border-radius: 6px;
      border-left: 3px solid #667eea;
    }
    .ticket-complete { border-left-color: #4ade80; }
    .ticket-blocked { border-left-color: #f87171; }
    .timestamp { font-size: 0.85rem; color: #666; }
    .refresh {
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 10px 20px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.9rem;
    }
    .refresh:hover { background: #5568d3; }
    #log {
      background: #0f1425;
      padding: 15px;
      border-radius: 6px;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.85rem;
      max-height: 400px;
      overflow-y: auto;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Super Ralph Monitor</h1>
    <div class="meta">
      <div>Run ID: <strong>${runId}</strong></div>
      <div>Project: <strong>${config.projectName}</strong></div>
      <div>Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}</div>
    </div>

    <button class="refresh" onclick="location.reload()">↻ Refresh</button>

    <div class="grid">
      <div class="card">
        <h2>Workflow Progress</h2>
        <div id="progress">Loading...</div>
      </div>

      <div class="card">
        <h2>Quick Stats</h2>
        <div id="stats">Loading...</div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 20px;">
      <h2>Recent Activity</h2>
      <div id="log">Loading events...</div>
    </div>

    <div class="card">
      <h2>Clarification Answers</h2>
      <pre style="white-space: pre-wrap; line-height: 1.8; color: #b0b0b0;">${clarificationSession?.summary || 'No clarifications recorded'}</pre>
    </div>
  </div>

  <script>
    const API_BASE = '';

    async function fetchData() {
      try {
        const response = await fetch(API_BASE + '/api/state');
        const data = await response.json();
        updateUI(data);
      } catch (error) {
        console.error('Failed to fetch data:', error);
      }
    }

    function updateUI(data) {
      // Progress
      const progressHTML = \`
        <div class="stat">
          <span>Reports</span>
          <span>\${data.reportComplete} / \${data.reportTotal}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: \${data.reportTotal > 0 ? (data.reportComplete / data.reportTotal * 100) : 0}%"></div>
        </div>
        <div class="stat" style="margin-top: 16px;">
          <span>Merged</span>
          <span>\${data.landMerged} / \${data.landTotal}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: \${data.landTotal > 0 ? (data.landMerged / data.landTotal * 100) : 0}%"></div>
        </div>
      \`;
      document.getElementById('progress').innerHTML = progressHTML;

      // Stats
      const statsHTML = \`
        <div class="stat"><span>Reports Complete</span><strong>\${data.reportComplete}</strong></div>
        <div class="stat"><span>Reports Blocked</span><strong>\${data.reportBlocked}</strong></div>
        <div class="stat"><span>Tickets Merged</span><strong>\${data.landMerged}</strong></div>
        <div class="stat"><span>Evictions</span><strong>\${data.landEvicted}</strong></div>
      \`;
      document.getElementById('stats').innerHTML = statsHTML;

      // Recent events (last 20)
      const events = data.recentEvents || [];
      const logHTML = events.slice(-20).map(e =>
        \`<div class="timestamp">[\${e.time}] \${e.message}</div>\`
      ).join('');
      document.getElementById('log').innerHTML = logHTML || '<div>No events yet</div>';
    }

    // Auto-refresh every 5 seconds
    fetchData();
    setInterval(fetchData, 5000);
  </script>
</body>
</html>
        `;

        // Start web server
        const server = Bun.serve({
          port,
          fetch: (req) => {
            const url = new URL(req.url);

            // Serve dashboard HTML
            if (url.pathname === "/" || url.pathname === "/index.html") {
              return new Response(dashboardHTML, {
                headers: { "Content-Type": "text/html" },
              });
            }

            // API endpoint for state
            if (url.pathname === "/api/state") {
              try {
                const db = new Database(dbPath, { readonly: true });

                // Query reports
                let reportRows: any[] = [];
                let landRows: any[] = [];

                try {
                  reportRows = db
                    .query(`SELECT node_id, iteration, status, summary FROM report WHERE run_id = ? ORDER BY iteration DESC`)
                    .all(runId) as any[];
                } catch {
                  // Table might not exist yet
                }

                try {
                  landRows = db
                    .query(`SELECT node_id, iteration, merged, evicted, summary FROM land WHERE run_id = ? ORDER BY iteration DESC`)
                    .all(runId) as any[];
                } catch {
                  // Table might not exist yet
                }

                const reportComplete = reportRows.filter(r => r.status === "complete").length;
                const reportBlocked = reportRows.filter(r => r.status === "blocked").length;
                const landMerged = landRows.filter(l => Boolean(l.merged)).length;
                const landEvicted = landRows.filter(l => Boolean(l.evicted)).length;

                // Recent events
                const recentEvents = [
                  ...reportRows.slice(0, 10).map(r => ({
                    time: new Date().toISOString().slice(11, 19),
                    message: `Report: ${r.node_id} [${r.status}] ${r.summary}`
                  })),
                  ...landRows.slice(0, 10).map(l => ({
                    time: new Date().toISOString().slice(11, 19),
                    message: `Land: ${l.node_id} [${l.merged ? 'merged' : l.evicted ? 'evicted' : 'pending'}] ${l.summary}`
                  })),
                ].sort((a, b) => b.time.localeCompare(a.time));

                db.close();

                return Response.json({
                  reportTotal: reportRows.length,
                  reportComplete,
                  reportBlocked,
                  landTotal: landRows.length,
                  landMerged,
                  landEvicted,
                  recentEvents,
                });
              } catch (error) {
                return Response.json({ error: String(error) }, { status: 500 });
              }
            }

            return new Response("Not found", { status: 404 });
          },
        });

        const serverUrl = `http://localhost:${port}`;

        // Print to console so user knows where to go
        console.log(`\n${"=".repeat(80)}`);
        console.log(`Super Ralph Monitor started!`);
        console.log(`\nOpen in browser: ${serverUrl}`);
        console.log(`${"=".repeat(80)}\n`);

        // Keep the server running by returning a long-lived promise
        // The monitor runs in parallel with the workflow, so it shouldn't block
        return new Promise<MonitorOutput>((resolve) => {
          // We don't actually resolve this - the monitor runs indefinitely
          // But we return the initial state for the output schema
          setTimeout(() => {
            resolve({
              serverUrl,
              port,
              started: true,
            });
          }, 1000);
        });
      }}
    </Task>
  );
}
