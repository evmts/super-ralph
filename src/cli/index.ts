#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { createCliRenderer, BoxRenderable, TextRenderable } from "@opentui/core";

type SmithersModule = typeof import("smithers-orchestrator");

type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type DetectedAgents = {
  claude: boolean;
  codex: boolean;
  gh: boolean;
};

type AgentSpec = {
  name: "claude" | "codex";
  agent: { generate: (options: any) => Promise<any> };
};

type WorkflowRunResult = {
  code: number;
  stdout: string;
  stderr: string;
  status: string | null;
};

const focusSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

const interpreterOutputSchema = z.object({
  projectName: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  focuses: z.array(focusSchema).min(1).max(12).optional(),
  specsPath: z.string().min(1).optional(),
  referenceFiles: z.array(z.string()).optional(),
  buildCmds: z.record(z.string(), z.string()).optional(),
  testCmds: z.record(z.string(), z.string()).optional(),
  preLandChecks: z.array(z.string()).optional(),
  postLandChecks: z.array(z.string()).optional(),
  codeStyle: z.string().min(1).optional(),
  reviewChecklist: z.array(z.string()).min(1).optional(),
  maxConcurrency: z.number().int().min(1).max(64).optional(),
  reasoning: z.string().optional(),
});

type InterpreterOutput = z.infer<typeof interpreterOutputSchema>;

type SuperRalphCliConfig = {
  projectName: string;
  projectId: string;
  focuses: Array<{ id: string; name: string }>;
  specsPath: string;
  referenceFiles: string[];
  buildCmds: Record<string, string>;
  testCmds: Record<string, string>;
  preLandChecks: string[];
  postLandChecks: string[];
  codeStyle: string;
  reviewChecklist: string[];
  maxConcurrency: number;
};

type MonitorSnapshot = {
  reportTotal: number;
  reportComplete: number;
  reportBlocked: number;
  landTotal: number;
  landMerged: number;
  landEvicted: number;
  newReports: Array<{ nodeId: string; status: string; summary: string; iteration: number }>;
  newLandEvents: Array<{ nodeId: string; merged: boolean; evicted: boolean; summary: string; iteration: number }>;
  newGitCommits: string[];
};

type IssueNote = {
  when: string;
  line: string;
  suggestion: string;
};

const CLI_FILE = fileURLToPath(import.meta.url);
const CLI_DIR = dirname(CLI_FILE);

function printHelp() {
  console.log(`Usage:
  super-ralph "prompt text"
  super-ralph ./PROMPT.md

Options:
  --cwd <path>                    Repo root (default: current directory)
  --max-concurrency <n>           Workflow max concurrency override
  --report-interval-minutes <n>   Monitoring report interval (default: 5)
  --run-id <id>                   Explicit Smithers run id
  --dry-run                       Generate workflow files but do not execute
  --no-tui                        Disable OpenTUI dashboard
  --help                          Show this help
`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    i += 1;
  }

  return { positional, flags };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const next = value.trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    output.push(next);
  }
  return output;
}

function normalizePathForPrompt(value: string): string {
  return value.replace(/\\/g, "/");
}

function toRepoRelativePath(repoRoot: string, value: string): string {
  const rel = relative(repoRoot, value);
  if (!rel || rel.startsWith("..") || rel.startsWith("/")) {
    return normalizePathForPrompt(value);
  }
  return normalizePathForPrompt(rel);
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runShell(command: string, cwd: string): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolvePromise) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      resolvePromise({
        code: 127,
        stdout,
        stderr: error.message,
      });
    });

    child.on("close", (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function commandExists(command: string, cwd: string): Promise<boolean> {
  const result = await runShell(`command -v ${shellEscape(command)} >/dev/null 2>&1`, cwd);
  return result.code === 0;
}

async function readPromptInput(rawInput: string, cwd: string): Promise<{ promptText: string; promptSourcePath: string | null }> {
  if (rawInput === "-") {
    const stdin = await Bun.stdin.text();
    return {
      promptText: stdin.trim(),
      promptSourcePath: null,
    };
  }

  const maybePath = resolve(cwd, rawInput);
  if (existsSync(maybePath)) {
    const content = await readFile(maybePath, "utf8");
    return {
      promptText: content.trim(),
      promptSourcePath: maybePath,
    };
  }

  return {
    promptText: rawInput.trim(),
    promptSourcePath: null,
  };
}

async function loadPackageScripts(repoRoot: string): Promise<Record<string, string>> {
  const packageJsonPath = join(repoRoot, "package.json");
  if (!existsSync(packageJsonPath)) return {};

  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
    if (!parsed || typeof parsed !== "object" || !parsed.scripts || typeof parsed.scripts !== "object") {
      return {};
    }
    return parsed.scripts;
  } catch {
    return {};
  }
}

function detectScriptRunner(repoRoot: string): "bun" | "pnpm" | "yarn" | "npm" {
  if (existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb"))) return "bun";
  if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
  return "npm";
}

function scriptCommand(runner: "bun" | "pnpm" | "yarn" | "npm", scriptName: string): string {
  if (runner === "bun") return `bun run ${scriptName}`;
  if (runner === "pnpm") return `pnpm run ${scriptName}`;
  if (runner === "yarn") return `yarn ${scriptName}`;
  return `npm run ${scriptName}`;
}

function fallbackFocuses(): Array<{ id: string; name: string }> {
  return [
    { id: "core", name: "Core Platform" },
    { id: "api", name: "API and Data" },
    { id: "workflow", name: "Workflow and Automation" },
  ];
}

async function buildFallbackConfig(repoRoot: string, promptSpecPath: string): Promise<SuperRalphCliConfig> {
  const scripts = await loadPackageScripts(repoRoot);
  const runner = detectScriptRunner(repoRoot);

  const buildCmds: Record<string, string> = {};
  const testCmds: Record<string, string> = {};

  if (scripts.typecheck) {
    buildCmds.typecheck = scriptCommand(runner, "typecheck");
  }
  if (scripts.build) {
    buildCmds.build = scriptCommand(runner, "build");
  }
  if (scripts.lint) {
    buildCmds.lint = scriptCommand(runner, "lint");
  }

  if (scripts.test) {
    testCmds.test = scriptCommand(runner, "test");
  }

  if (existsSync(join(repoRoot, "go.mod"))) {
    buildCmds.go = buildCmds.go ?? "go build ./...";
    testCmds.go = testCmds.go ?? "go test ./...";
  }

  if (existsSync(join(repoRoot, "Cargo.toml"))) {
    buildCmds.rust = buildCmds.rust ?? "cargo build";
    testCmds.rust = testCmds.rust ?? "cargo test";
  }

  if (Object.keys(buildCmds).length === 0) {
    buildCmds.verify = runner === "bun" ? "bun run typecheck" : "echo \"Add build/typecheck command\"";
  }

  if (Object.keys(testCmds).length === 0) {
    testCmds.tests = runner === "bun" ? "bun test" : "echo \"Add test command\"";
  }

  const specsPathCandidates = [
    join(repoRoot, "docs/specs/engineering.md"),
    join(repoRoot, "docs/specs"),
    join(repoRoot, "specs"),
    promptSpecPath,
  ];

  const chosenSpecs = specsPathCandidates.find((candidate) => existsSync(candidate)) ?? promptSpecPath;

  const projectName = basename(repoRoot);
  const maxConcurrency = clamp(Number(process.env.WORKFLOW_MAX_CONCURRENCY ?? "6") || 6, 1, 32);

  return {
    projectName,
    projectId: slugify(projectName),
    focuses: fallbackFocuses(),
    specsPath: toRepoRelativePath(repoRoot, chosenSpecs),
    referenceFiles: uniqueStrings([
      toRepoRelativePath(repoRoot, promptSpecPath),
      existsSync(join(repoRoot, "README.md")) ? "README.md" : "",
      existsSync(join(repoRoot, "docs")) ? "docs" : "",
    ]),
    buildCmds,
    testCmds,
    preLandChecks: Object.values(buildCmds),
    postLandChecks: Object.values(testCmds),
    codeStyle: "Follow existing project conventions and keep changes minimal and test-driven.",
    reviewChecklist: [
      "Spec compliance",
      "Tests cover behavior changes",
      "No regression risk in existing flows",
      "Error handling and observability",
    ],
    maxConcurrency,
  };
}

function extractFirstJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];

    if (start === -1) {
      if (ch === "{" || ch === "[") {
        start = i;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{" || ch === "[") depth += 1;
    if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          start = -1;
        }
      }
    }
  }

  return undefined;
}

function mergeWithFallbackConfig(
  repoRoot: string,
  aiOutput: InterpreterOutput,
  fallback: SuperRalphCliConfig,
): SuperRalphCliConfig {
  const projectName = aiOutput.projectName?.trim() || fallback.projectName;
  const projectId = slugify(aiOutput.projectId?.trim() || projectName || fallback.projectId);

  const focuses = (aiOutput.focuses ?? fallback.focuses)
    .map((focus) => ({
      id: slugify(String(focus.id || focus.name || "focus")),
      name: String(focus.name || focus.id || "Focus").trim(),
    }))
    .filter((focus) => focus.id && focus.name);

  const normalizedFocuses = focuses.length > 0 ? focuses : fallback.focuses;

  const buildCmds = Object.fromEntries(
    Object.entries(aiOutput.buildCmds ?? fallback.buildCmds)
      .map(([key, value]) => [slugify(key), String(value).trim()])
      .filter(([, value]) => Boolean(value)),
  );

  const testCmds = Object.fromEntries(
    Object.entries(aiOutput.testCmds ?? fallback.testCmds)
      .map(([key, value]) => [slugify(key), String(value).trim()])
      .filter(([, value]) => Boolean(value)),
  );

  const specsPathRaw = aiOutput.specsPath?.trim() || fallback.specsPath;
  const specsPathResolved = specsPathRaw.startsWith("/")
    ? specsPathRaw
    : resolve(repoRoot, specsPathRaw);
  const specsPath = toRepoRelativePath(repoRoot, specsPathResolved);

  const referenceFiles = uniqueStrings(
    (aiOutput.referenceFiles ?? fallback.referenceFiles)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        if (item.startsWith("/")) return toRepoRelativePath(repoRoot, item);
        return normalizePathForPrompt(item);
      }),
  );

  const reviewChecklist = uniqueStrings(
    (aiOutput.reviewChecklist ?? fallback.reviewChecklist)
      .map((item) => item.trim())
      .filter(Boolean),
  );

  const preLandChecks = uniqueStrings(
    (aiOutput.preLandChecks ?? Object.values(buildCmds)).map((item) => item.trim()).filter(Boolean),
  );

  const postLandChecks = uniqueStrings(
    (aiOutput.postLandChecks ?? Object.values(testCmds)).map((item) => item.trim()).filter(Boolean),
  );

  return {
    projectName,
    projectId,
    focuses: normalizedFocuses,
    specsPath,
    referenceFiles: referenceFiles.length > 0 ? referenceFiles : fallback.referenceFiles,
    buildCmds: Object.keys(buildCmds).length > 0 ? buildCmds : fallback.buildCmds,
    testCmds: Object.keys(testCmds).length > 0 ? testCmds : fallback.testCmds,
    preLandChecks: preLandChecks.length > 0 ? preLandChecks : fallback.preLandChecks,
    postLandChecks: postLandChecks.length > 0 ? postLandChecks : fallback.postLandChecks,
    codeStyle: (aiOutput.codeStyle?.trim() || fallback.codeStyle),
    reviewChecklist: reviewChecklist.length > 0 ? reviewChecklist : fallback.reviewChecklist,
    maxConcurrency: clamp(
      Number(aiOutput.maxConcurrency ?? fallback.maxConcurrency) || fallback.maxConcurrency,
      1,
      64,
    ),
  };
}

async function loadSmithersModule(): Promise<SmithersModule> {
  try {
    return await import("smithers-orchestrator");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `smithers-orchestrator is required for the super-ralph CLI. Install with: bun add smithers-orchestrator\nDetails: ${detail}`,
    );
  }
}

function buildInterpreterPrompt(params: {
  promptText: string;
  repoRoot: string;
  fallbackConfig: SuperRalphCliConfig;
  promptSpecPath: string;
  promptSourcePath: string | null;
  detectedAgents: DetectedAgents;
  packageScripts: Record<string, string>;
}): string {
  const scriptsBlock = Object.entries(params.packageScripts)
    .map(([name, cmd]) => `- ${name}: ${cmd}`)
    .join("\n");

  const agentBlock = [
    params.detectedAgents.claude ? "- claude CLI available" : "- claude CLI unavailable",
    params.detectedAgents.codex ? "- codex CLI available" : "- codex CLI unavailable",
  ].join("\n");

  return [
    "You are a workflow-config assistant for super-ralph.",
    "Return ONLY JSON. No markdown, no code fences, no commentary.",
    "",
    "Goal:",
    "Convert the user request into practical SuperRalph configuration fields.",
    "",
    "Output JSON shape:",
    JSON.stringify(
      {
        projectName: "string",
        projectId: "string-kebab-case",
        focuses: [{ id: "string", name: "string" }],
        specsPath: "string",
        referenceFiles: ["string"],
        buildCmds: { language_or_tool: "command" },
        testCmds: { language_or_tool: "command" },
        preLandChecks: ["command"],
        postLandChecks: ["command"],
        codeStyle: "string",
        reviewChecklist: ["string"],
        maxConcurrency: 8,
        reasoning: "string",
      },
      null,
      2,
    ),
    "",
    "Hard requirements:",
    "- Commands must be realistic for the repo.",
    "- Keep focuses concise (2-6).",
    "- Prefer paths relative to repo root.",
    "- Include the user prompt file as a reference when relevant.",
    "- Never return null; omit fields instead.",
    "",
    `Repo root: ${params.repoRoot}`,
    `Prompt source path: ${params.promptSourcePath ? params.promptSourcePath : "inline text"}`,
    `Prompt materialized file: ${params.promptSpecPath}`,
    "",
    "Detected CLIs:",
    agentBlock,
    "",
    "Existing package scripts:",
    scriptsBlock || "(none)",
    "",
    "Fallback config if unsure:",
    JSON.stringify(params.fallbackConfig, null, 2),
    "",
    "User request:",
    params.promptText,
  ].join("\n");
}

function decodeInterpreterResult(rawResult: any): unknown {
  if (rawResult && typeof rawResult === "object") {
    if (rawResult.output && typeof rawResult.output === "object") {
      return rawResult.output;
    }
    if (rawResult.experimental_output && typeof rawResult.experimental_output === "object") {
      return rawResult.experimental_output;
    }
  }

  const textCandidates = [
    typeof rawResult?.text === "string" ? rawResult.text : "",
    typeof rawResult?.output === "string" ? rawResult.output : "",
    typeof rawResult === "string" ? rawResult : "",
  ].filter(Boolean);

  for (const candidate of textCandidates) {
    const parsed = extractFirstJsonValue(candidate);
    if (parsed !== undefined) return parsed;
  }

  return undefined;
}

function coerceInterpreterPayload(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "string") {
    const parsed = extractFirstJsonValue(value);
    return parsed === undefined ? value : coerceInterpreterPayload(parsed);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const next = coerceInterpreterPayload(item);
      if (next && typeof next === "object" && !Array.isArray(next)) {
        return next;
      }
    }
    return value[0];
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const directKeys = [
      "projectName",
      "projectId",
      "focuses",
      "buildCmds",
      "testCmds",
      "reviewChecklist",
    ];
    if (directKeys.some((key) => key in record)) {
      return record;
    }

    const nestedKeys = ["output", "result", "data", "message", "content", "text"];
    for (const key of nestedKeys) {
      const nested = record[key];
      if (nested === undefined || nested === null) continue;
      const next = coerceInterpreterPayload(nested);
      if (next !== undefined) return next;
    }
  }

  return value;
}

async function createInterpreterAgents(
  smithers: SmithersModule,
  repoRoot: string,
  detectedAgents: DetectedAgents,
): Promise<AgentSpec[]> {
  const output: AgentSpec[] = [];

  if (detectedAgents.claude) {
    output.push({
      name: "claude",
      agent: new smithers.ClaudeCodeAgent({
        cwd: repoRoot,
        model: "claude-sonnet-4-6",
        outputFormat: "json",
        dangerouslySkipPermissions: true,
        timeoutMs: 10 * 60 * 1000,
      }),
    });
  }

  if (detectedAgents.codex) {
    output.push({
      name: "codex",
      agent: new smithers.CodexAgent({
        cwd: repoRoot,
        model: "gpt-5.3-codex",
        yolo: true,
        timeoutMs: 10 * 60 * 1000,
      }),
    });
  }

  return output;
}

async function interpretPromptConfig(params: {
  smithers: SmithersModule;
  repoRoot: string;
  promptText: string;
  promptSpecPath: string;
  promptSourcePath: string | null;
  detectedAgents: DetectedAgents;
  fallbackConfig: SuperRalphCliConfig;
}): Promise<{ config: SuperRalphCliConfig; sourceAgent: string; rawOutput: string }> {
  const packageScripts = await loadPackageScripts(params.repoRoot);
  const interpreterPrompt = buildInterpreterPrompt({
    promptText: params.promptText,
    repoRoot: params.repoRoot,
    fallbackConfig: params.fallbackConfig,
    promptSpecPath: params.promptSpecPath,
    promptSourcePath: params.promptSourcePath,
    detectedAgents: params.detectedAgents,
    packageScripts,
  });

  const agentSpecs = await createInterpreterAgents(params.smithers, params.repoRoot, params.detectedAgents);
  if (agentSpecs.length === 0) {
    throw new Error("No planning agent is available. Install claude and/or codex CLI.");
  }

  const errors: string[] = [];

  for (const spec of agentSpecs) {
    try {
      const result = await spec.agent.generate({
        prompt: interpreterPrompt,
        timeout: { totalMs: 10 * 60 * 1000 },
      });

      const decoded = coerceInterpreterPayload(decodeInterpreterResult(result));
      if (!decoded) {
        throw new Error("Agent did not return parseable JSON.");
      }

      const aiOutput = interpreterOutputSchema.parse(decoded);
      const config = mergeWithFallbackConfig(params.repoRoot, aiOutput, params.fallbackConfig);
      const rawOutput = typeof result?.text === "string"
        ? result.text
        : JSON.stringify(decoded, null, 2);
      return {
        config,
        sourceAgent: spec.name,
        rawOutput,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`${spec.name}: ${detail}`);
    }
  }

  throw new Error(`All planning agents failed. ${errors.join(" | ")}`);
}

function findSmithersCliPath(repoRoot: string): string | null {
  const candidates = [
    join(repoRoot, "node_modules/smithers-orchestrator/src/cli/index.ts"),
    resolve(CLI_DIR, "../../node_modules/smithers-orchestrator/src/cli/index.ts"),
    join(process.env.HOME || "", "smithers/src/cli/index.ts"),
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function renderWorkflowFile(params: {
  config: SuperRalphCliConfig;
  dbPath: string;
  hasClaude: boolean;
  hasCodex: boolean;
}): string {
  const serializedConfig = JSON.stringify(
    {
      ...params.config,
      dbPath: params.dbPath,
      taskRetries: 3,
      mergeQueueOrdering: "report-complete-fifo",
      maxSpeculativeDepth: 3,
    },
    null,
    2,
  );

  return `import React from "react";
import { createSmithers, ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";
import { SuperRalph, ralphOutputSchemas } from "super-ralph";

const CONFIG = ${serializedConfig} as const;
const REPO_ROOT = process.cwd();
const HAS_CLAUDE = ${params.hasClaude ? "true" : "false"};
const HAS_CODEX = ${params.hasCodex ? "true" : "false"};

const { smithers, outputs, Workflow } = createSmithers(ralphOutputSchemas, {
  dbPath: CONFIG.dbPath,
});

function createClaude(systemPrompt: string) {
  return new ClaudeCodeAgent({
    model: "claude-sonnet-4-6",
    systemPrompt,
    cwd: REPO_ROOT,
    dangerouslySkipPermissions: true,
    timeoutMs: 60 * 60 * 1000,
  });
}

function createCodex(systemPrompt: string) {
  return new CodexAgent({
    model: "gpt-5.3-codex",
    systemPrompt,
    cwd: REPO_ROOT,
    yolo: true,
    timeoutMs: 60 * 60 * 1000,
  });
}

function choose(primary: "claude" | "codex", systemPrompt: string) {
  if (HAS_CLAUDE && HAS_CODEX) {
    if (primary === "claude") {
      return [createClaude(systemPrompt), createCodex(systemPrompt)];
    }
    return [createCodex(systemPrompt), createClaude(systemPrompt)];
  }
  if (HAS_CLAUDE) return createClaude(systemPrompt);
  return createCodex(systemPrompt);
}

export default smithers((ctx) => (
  <Workflow name={\`super-ralph-\${CONFIG.projectId}\`}>
    <SuperRalph
      ctx={ctx}
      outputs={outputs}
      focuses={CONFIG.focuses}
      projectId={CONFIG.projectId}
      projectName={CONFIG.projectName}
      specsPath={CONFIG.specsPath}
      referenceFiles={CONFIG.referenceFiles}
      buildCmds={CONFIG.buildCmds}
      testCmds={CONFIG.testCmds}
      preLandChecks={CONFIG.preLandChecks}
      postLandChecks={CONFIG.postLandChecks}
      codeStyle={CONFIG.codeStyle}
      reviewChecklist={CONFIG.reviewChecklist}
      maxConcurrency={CONFIG.maxConcurrency}
      taskRetries={CONFIG.taskRetries}
      mergeQueueOrdering={CONFIG.mergeQueueOrdering}
      maxSpeculativeDepth={CONFIG.maxSpeculativeDepth}
      agents={{
        planning: choose("claude", "Plan and research next tickets."),
        implementation: choose("claude", "Implement with test-driven development and jj workflows."),
        testing: choose("claude", "Run tests and validate behavior changes."),
        reviewing: choose("codex", "Review for regressions, spec drift, and correctness."),
        reporting: choose("claude", "Write concise, accurate ticket status reports."),
      }}
    />
  </Workflow>
));
`;
}

function buildBar(done: number, total: number, width = 18): string {
  if (total <= 0) return `[${"-".repeat(width)}] 0/0`;
  const ratio = clamp(done / total, 0, 1);
  const filled = Math.round(width * ratio);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${done}/${total}`;
}

function isIssueLine(line: string): boolean {
  const lowered = line.toLowerCase();
  return lowered.includes("error") || lowered.includes("✗") || lowered.includes("failed");
}

function suggestFix(line: string): string {
  const lowered = line.toLowerCase();

  if (lowered.includes("expecting value: line 1 column 1") && lowered.includes("kimi")) {
    return "Kimi returned non-JSON output. Retry with Claude/Codex fallback and inspect ~/.kimi/logs/kimi.log.";
  }
  if (lowered.includes("mdx prompt could not be rendered")) {
    return "MDX preload is missing. Ensure smithers runs with `bun -r <preload.ts>` registering mdxPlugin().";
  }
  if (lowered.includes("acceptancecriteria") && lowered.includes("map is not a function")) {
    return "Normalize acceptanceCriteria to string[] before passing prompt props.";
  }
  if (lowered.includes("command not found") && lowered.includes("jj")) {
    return "Install jj, then run `jj git init --colocate` or use a jj-colocated repo.";
  }
  if (lowered.includes("peer closed connection") || lowered.includes("incomplete chunked read")) {
    return "Transient provider/network error. Retry the task with fallback agent ordering.";
  }

  return "Check the failing task logs and rerun with `--report-interval-minutes 1` for tighter monitoring.";
}

class WorkflowMonitor {
  private readonly reportRowsSeen = new Set<string>();
  private readonly landRowsSeen = new Set<string>();
  private readonly events: string[] = [];
  private readonly issueNotes: IssueNote[] = [];

  private renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null;
  private headerText: TextRenderable | null = null;
  private eventsText: TextRenderable | null = null;
  private summaryText: TextRenderable | null = null;
  private reportText: TextRenderable | null = null;
  private issueText: TextRenderable | null = null;

  private status = "starting";
  private lastGitHead: string | null = null;
  private lastReportAt = 0;
  private latestSnapshot: MonitorSnapshot | null = null;
  private latestReportText = "Throttled report has not run yet.";
  private tuiEnabled: boolean;

  constructor(
    private readonly options: {
      repoRoot: string;
      dbPath: string;
      runId: string;
      promptLabel: string;
      reportIntervalMs: number;
      useTui: boolean;
      ghAvailable: boolean;
      generatedDir: string;
    },
  ) {
    this.tuiEnabled = options.useTui;
  }

  async start() {
    if (!this.tuiEnabled || !process.stdout.isTTY) {
      this.tuiEnabled = false;
      return;
    }

    try {
      this.renderer = await createCliRenderer({
        useMouse: false,
        useConsole: false,
        useAlternateScreen: true,
      });

      const root = new BoxRenderable(this.renderer, {
        id: "root",
        border: true,
        title: "Super Ralph CLI Monitor",
        width: "100%",
        height: "100%",
        padding: 1,
        flexDirection: "column",
        gap: 1,
      });

      this.headerText = new TextRenderable(this.renderer, {
        id: "header",
        content: "Booting monitor...",
        height: 3,
      });

      this.summaryText = new TextRenderable(this.renderer, {
        id: "summary",
        content: "Waiting for workflow output...",
        height: 9,
      });

      this.reportText = new TextRenderable(this.renderer, {
        id: "report",
        content: "Throttled report has not run yet.",
        height: 11,
      });

      this.eventsText = new TextRenderable(this.renderer, {
        id: "events",
        content: "",
        height: 10,
      });

      this.issueText = new TextRenderable(this.renderer, {
        id: "issues",
        content: "No issues detected.",
        height: "auto",
      });

      root.add(this.headerText);
      root.add(this.summaryText);
      root.add(this.reportText);
      root.add(this.eventsText);
      root.add(this.issueText);

      this.renderer.root.add(root);
      this.renderer.start();
      this.updateView();
    } catch {
      this.tuiEnabled = false;
    }
  }

  stop() {
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
  }

  setStatus(status: string) {
    this.status = status;
    this.updateView();
  }

  appendEvent(line: string) {
    const now = new Date().toISOString();
    this.events.push(`[${now}] ${line}`);
    if (this.events.length > 400) {
      this.events.splice(0, this.events.length - 400);
    }

    if (isIssueLine(line)) {
      this.issueNotes.push({
        when: now,
        line,
        suggestion: suggestFix(line),
      });
      if (this.issueNotes.length > 50) {
        this.issueNotes.splice(0, this.issueNotes.length - 50);
      }
    }

    this.updateView();
  }

  async maybeEmitSnapshot(force = false) {
    const now = Date.now();
    if (!force && now - this.lastReportAt < this.options.reportIntervalMs) {
      return;
    }

    this.lastReportAt = now;
    const snapshot = await this.collectSnapshot();
    this.latestSnapshot = snapshot;

    const lines = [
      `Snapshot @ ${new Date(now).toISOString()}`,
      `Reports complete ${buildBar(snapshot.reportComplete, snapshot.reportTotal)}`,
      `Reports blocked  ${buildBar(snapshot.reportBlocked, snapshot.reportTotal)}`,
      `Merged tickets   ${buildBar(snapshot.landMerged, snapshot.landTotal)}`,
      `Evictions       ${snapshot.landEvicted}`,
      "",
      "New report outputs:",
      ...(
        snapshot.newReports.length > 0
          ? snapshot.newReports.slice(0, 6).map((row) => `- ${row.nodeId} [${row.status}] ${row.summary}`)
          : ["- none"]
      ),
      "",
      "New landing outputs:",
      ...(
        snapshot.newLandEvents.length > 0
          ? snapshot.newLandEvents.slice(0, 6).map((row) => {
              const status = row.merged ? "merged" : row.evicted ? "evicted" : "pending";
              return `- ${row.nodeId} [${status}] ${row.summary}`;
            })
          : ["- none"]
      ),
      "",
      "Git changes since last report:",
      ...(
        snapshot.newGitCommits.length > 0
          ? snapshot.newGitCommits.slice(0, 8).map((line) => `- ${line}`)
          : ["- none"]
      ),
    ];

    const report = lines.join("\n");
    this.latestReportText = report;
    this.reportText && (this.reportText.content = report);

    if (!this.tuiEnabled) {
      console.log(`\n=== Super Ralph Report ===\n${report}\n`);
    }

    this.updateView();
  }

  async writeIssueDraftIfNeeded(): Promise<string | null> {
    if (this.issueNotes.length === 0) return null;

    const issueDir = join(this.options.generatedDir, "issues");
    await mkdir(issueDir, { recursive: true });

    const issueFile = join(issueDir, `issue-${Date.now()}.md`);
    const recent = this.issueNotes.slice(-12);

    const body = [
      `# super-ralph workflow issue`,
      "",
      `- Run ID: ${this.options.runId}`,
      `- Repo: ${this.options.repoRoot}`,
      `- Prompt: ${this.options.promptLabel}`,
      "",
      "## Recent errors",
      ...recent.map((issue) => `- ${issue.when} :: ${issue.line}`),
      "",
      "## Suggested fixes",
      ...uniqueStrings(recent.map((issue) => issue.suggestion)).map((text) => `- ${text}`),
      "",
      "## Latest throttled snapshot",
      "```",
      this.latestReportText || "No snapshot available",
      "```",
    ].join("\n");

    await writeFile(issueFile, body, "utf8");
    return issueFile;
  }

  private async collectSnapshot(): Promise<MonitorSnapshot> {
    let reportRows: Array<{ nodeId: string; iteration: number; status: string; summary: string }> = [];
    let landRows: Array<{ nodeId: string; iteration: number; merged: number | boolean; evicted: number | boolean; summary: string }> = [];

    if (existsSync(this.options.dbPath)) {
      try {
        const db = new Database(this.options.dbPath);
        try {
          reportRows = db
            .query(
              `SELECT node_id AS nodeId, iteration, status, summary
               FROM report
               WHERE run_id = ?
               ORDER BY iteration DESC`,
            )
            .all(this.options.runId) as any;
        } catch {
          reportRows = [];
        }

        try {
          landRows = db
            .query(
              `SELECT node_id AS nodeId, iteration, merged, evicted, summary
               FROM land
               WHERE run_id = ?
               ORDER BY iteration DESC`,
            )
            .all(this.options.runId) as any;
        } catch {
          landRows = [];
        }

        db.close();
      } catch {
        // ignore db read failures in monitor loop
      }
    }

    const newReports: MonitorSnapshot["newReports"] = [];
    for (const row of reportRows) {
      const key = `${row.nodeId}:${row.iteration}`;
      if (this.reportRowsSeen.has(key)) continue;
      this.reportRowsSeen.add(key);
      newReports.push({
        nodeId: row.nodeId,
        status: row.status,
        summary: row.summary,
        iteration: row.iteration,
      });
    }

    const newLandEvents: MonitorSnapshot["newLandEvents"] = [];
    for (const row of landRows) {
      const key = `${row.nodeId}:${row.iteration}`;
      if (this.landRowsSeen.has(key)) continue;
      this.landRowsSeen.add(key);
      newLandEvents.push({
        nodeId: row.nodeId,
        merged: Boolean(row.merged),
        evicted: Boolean(row.evicted),
        summary: row.summary,
        iteration: row.iteration,
      });
    }

    const reportComplete = reportRows.filter((row) => row.status === "complete").length;
    const reportBlocked = reportRows.filter((row) => row.status === "blocked").length;
    const landMerged = landRows.filter((row) => Boolean(row.merged)).length;
    const landEvicted = landRows.filter((row) => Boolean(row.evicted)).length;

    const newGitCommits = await this.collectGitDelta();

    return {
      reportTotal: reportRows.length,
      reportComplete,
      reportBlocked,
      landTotal: landRows.length,
      landMerged,
      landEvicted,
      newReports,
      newLandEvents,
      newGitCommits,
    };
  }

  private async collectGitDelta(): Promise<string[]> {
    const headRes = await runShell("git rev-parse HEAD", this.options.repoRoot);
    if (headRes.code !== 0) return [];

    const head = headRes.stdout.trim();
    if (!head) return [];

    if (!this.lastGitHead) {
      this.lastGitHead = head;
      return [];
    }

    if (this.lastGitHead === head) {
      return [];
    }

    const logRes = await runShell(
      `git log --oneline --no-decorate ${shellEscape(`${this.lastGitHead}..${head}`)}`,
      this.options.repoRoot,
    );

    this.lastGitHead = head;

    if (logRes.code !== 0) {
      return [];
    }

    return logRes.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private updateView() {
    const recentEvents = this.events.slice(-10);
    const issues = this.issueNotes.slice(-4);

    const header = [
      `Status: ${this.status}`,
      `Run ID: ${this.options.runId}`,
      `Prompt: ${this.options.promptLabel}`,
      `Report cadence: every ${(this.options.reportIntervalMs / 60_000).toFixed(1)} min`,
    ].join("\n");

    const summary = this.latestSnapshot
      ? [
          `Report rows: ${this.latestSnapshot.reportTotal} (${this.latestSnapshot.reportComplete} complete / ${this.latestSnapshot.reportBlocked} blocked)`,
          `Landing rows: ${this.latestSnapshot.landTotal} (${this.latestSnapshot.landMerged} merged / ${this.latestSnapshot.landEvicted} evicted)`,
          `Unique errors: ${this.issueNotes.length}`,
          this.options.ghAvailable
            ? "gh detected: issue drafts can be opened directly"
            : "gh not detected: issue drafting only",
        ].join("\n")
      : "Waiting for first database snapshot...";

    const issueBlock = issues.length > 0
      ? issues
        .map((issue) => `- ${issue.line}\n  fix: ${issue.suggestion}`)
        .join("\n")
      : "No issues detected.";

    this.headerText && (this.headerText.content = header);
    this.summaryText && (this.summaryText.content = summary);
    this.eventsText && (this.eventsText.content = `Recent events:\n${recentEvents.join("\n") || "(none)"}`);
    this.issueText && (this.issueText.content = `Issue hints:\n${issueBlock}`);

    if (!this.tuiEnabled) return;
    this.renderer?.requestRender();
  }
}

async function streamChildOutput(params: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  onStdoutLine: (line: string) => void;
  onStderrLine: (line: string) => void;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const stdoutReader = createInterface({ input: child.stdout });
    stdoutReader.on("line", (line) => {
      stdout += `${line}\n`;
      params.onStdoutLine(line);
    });

    const stderrReader = createInterface({ input: child.stderr });
    stderrReader.on("line", (line) => {
      stderr += `${line}\n`;
      params.onStderrLine(line);
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });

    child.on("close", (code) => {
      stdoutReader.close();
      stderrReader.close();
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function extractRunStatus(stdout: string): string | null {
  const parsed = extractFirstJsonValue(stdout);
  if (!parsed || typeof parsed !== "object") return null;
  const status = (parsed as any).status;
  return typeof status === "string" ? status : null;
}

async function runWorkflowManaged(params: {
  repoRoot: string;
  smithersCliPath: string;
  preloadPath: string;
  workflowPath: string;
  runId: string;
  maxConcurrency: number;
  monitor: WorkflowMonitor;
}): Promise<WorkflowRunResult> {
  let mode: "run" | "resume" = "run";
  let attempts = 0;
  let finalResult: WorkflowRunResult = { code: 1, stdout: "", stderr: "", status: null };

  while (attempts < 5) {
    attempts += 1;

    const args = [
      "-r",
      params.preloadPath,
      "run",
      params.smithersCliPath,
      mode,
      params.workflowPath,
      "--root",
      params.repoRoot,
      "--run-id",
      params.runId,
      "--max-concurrency",
      String(params.maxConcurrency),
    ];

    params.monitor.appendEvent(`[launcher] bun ${args.join(" ")}`);
    params.monitor.setStatus(`workflow-${mode}`);

    const env = { ...(process.env as Record<string, string>) };
    env.USE_CLI_AGENTS = "1";
    env.SMITHERS_DEBUG = "1";
    delete env.CLAUDECODE;

    const result = await streamChildOutput({
      command: "bun",
      args,
      cwd: params.repoRoot,
      env,
      onStdoutLine: (line) => {
        if (line.trim()) params.monitor.appendEvent(`[stdout] ${line}`);
      },
      onStderrLine: (line) => {
        if (line.trim()) params.monitor.appendEvent(`[stderr] ${line}`);
      },
    });

    finalResult = {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      status: extractRunStatus(result.stdout),
    };

    if (result.code === 0) {
      params.monitor.setStatus("finished");
      return finalResult;
    }

    if (result.code === 2 || result.code === 3) {
      params.monitor.setStatus(result.code === 2 ? "cancelled" : "waiting-approval");
      return finalResult;
    }

    params.monitor.appendEvent(`[launcher] workflow exited with code ${result.code}; attempting resume`);
    params.monitor.setStatus("restart-pending");
    mode = "resume";

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
  }

  params.monitor.setStatus("failed");
  return finalResult;
}

async function ensureJjAvailable(repoRoot: string) {
  const ok = await commandExists("jj", repoRoot);
  if (ok) return;

  const message = [
    "jj is required before super-ralph can run.",
    "Install jj, then rerun this command.",
    "",
    "Install options:",
    "- macOS: brew install jj",
    "- Linux (cargo): cargo install --locked jj-cli",
    "- Verify: jj --version",
    "",
    "If this repo is not jj-colocated yet:",
    "- jj git init --colocate",
  ].join("\n");

  throw new Error(message);
}

async function detectAgents(repoRoot: string): Promise<DetectedAgents> {
  const [claude, codex, gh] = await Promise.all([
    commandExists("claude", repoRoot),
    commandExists("codex", repoRoot),
    commandExists("gh", repoRoot),
  ]);

  return { claude, codex, gh };
}

async function writeGeneratedFiles(params: {
  repoRoot: string;
  generatedDir: string;
  promptText: string;
  config: SuperRalphCliConfig;
  hasClaude: boolean;
  hasCodex: boolean;
}): Promise<{
  workflowPath: string;
  preloadPath: string;
  promptPath: string;
  dbPath: string;
}> {
  await mkdir(params.generatedDir, { recursive: true });

  const promptPath = join(params.generatedDir, "PROMPT.md");
  const preloadPath = join(params.generatedDir, "preload.ts");
  const bunfigPath = join(params.generatedDir, "bunfig.toml");
  const workflowPath = join(params.generatedDir, "workflow.tsx");
  const configPath = join(params.generatedDir, "config.json");

  await writeFile(promptPath, `${params.promptText.trim()}\n`, "utf8");
  await writeFile(
    preloadPath,
    `import { mdxPlugin } from "smithers-orchestrator/mdx-plugin";\n\nmdxPlugin();\n`,
    "utf8",
  );
  await writeFile(bunfigPath, `preload = ["./preload.ts"]\n`, "utf8");

  const dbPath = toRepoRelativePath(params.repoRoot, join(params.repoRoot, ".super-ralph/workflow.db"));

  const config = {
    ...params.config,
    specsPath: params.config.specsPath,
    referenceFiles: uniqueStrings([
      ...params.config.referenceFiles,
      toRepoRelativePath(params.repoRoot, promptPath),
    ]),
  };

  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const workflowSource = renderWorkflowFile({
    config,
    dbPath,
    hasClaude: params.hasClaude,
    hasCodex: params.hasCodex,
  });
  await writeFile(workflowPath, workflowSource, "utf8");

  return {
    workflowPath,
    preloadPath,
    promptPath,
    dbPath: join(params.repoRoot, dbPath),
  };
}

function resolveFlagNumber(
  flags: Record<string, string | boolean>,
  key: string,
  fallback: number,
): number {
  const raw = flags[key];
  if (raw === undefined || raw === true) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.flags.help || parsed.positional.length === 0) {
    printHelp();
    process.exit(parsed.flags.help ? 0 : 1);
  }

  const repoRoot = resolve(
    typeof parsed.flags.cwd === "string" ? parsed.flags.cwd : process.cwd(),
  );

  const rawPromptInput = parsed.positional.join(" ").trim();
  const { promptText, promptSourcePath } = await readPromptInput(rawPromptInput, repoRoot);

  if (!promptText) {
    throw new Error("Prompt input is empty.");
  }

  await ensureJjAvailable(repoRoot);

  const smithersCliPath = findSmithersCliPath(repoRoot);
  if (!smithersCliPath) {
    throw new Error(
      "Could not find smithers CLI. Install smithers-orchestrator in this repo: bun add smithers-orchestrator",
    );
  }

  const detectedAgents = await detectAgents(repoRoot);
  if (!detectedAgents.claude && !detectedAgents.codex) {
    throw new Error(
      "No supported coding agent CLI detected. Install claude and/or codex, then rerun.",
    );
  }

  const generatedDir = join(repoRoot, ".super-ralph", "generated");
  await mkdir(generatedDir, { recursive: true });

  const promptSpecPath = join(generatedDir, "PROMPT.md");
  const fallbackConfig = await buildFallbackConfig(repoRoot, promptSpecPath);

  const smithers = await loadSmithersModule();

  const interpreted = await interpretPromptConfig({
    smithers,
    repoRoot,
    promptText,
    promptSpecPath,
    promptSourcePath,
    detectedAgents,
    fallbackConfig,
  });

  const maxConcurrencyOverride = resolveFlagNumber(parsed.flags, "max-concurrency", interpreted.config.maxConcurrency);
  const reportIntervalMinutes = resolveFlagNumber(parsed.flags, "report-interval-minutes", 5);

  const generated = await writeGeneratedFiles({
    repoRoot,
    generatedDir,
    promptText,
    config: {
      ...interpreted.config,
      maxConcurrency: maxConcurrencyOverride,
    },
    hasClaude: detectedAgents.claude,
    hasCodex: detectedAgents.codex,
  });

  const runId = typeof parsed.flags["run-id"] === "string"
    ? String(parsed.flags["run-id"])
    : `sr-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

  const noTui = Boolean(parsed.flags["no-tui"]);
  const monitor = new WorkflowMonitor({
    repoRoot,
    dbPath: generated.dbPath,
    runId,
    promptLabel: promptSourcePath ? toRepoRelativePath(repoRoot, promptSourcePath) : "inline prompt",
    reportIntervalMs: Math.max(60_000, reportIntervalMinutes * 60_000),
    useTui: !noTui,
    ghAvailable: detectedAgents.gh,
    generatedDir,
  });

  console.log(`super-ralph config interpreter: ${interpreted.sourceAgent}`);
  console.log(`super-ralph workflow file: ${toRepoRelativePath(repoRoot, generated.workflowPath)}`);
  console.log(`super-ralph db path: ${toRepoRelativePath(repoRoot, generated.dbPath)}`);
  console.log(`super-ralph run id: ${runId}`);
  console.log(`agents detected: claude=${detectedAgents.claude} codex=${detectedAgents.codex} gh=${detectedAgents.gh}`);

  if (parsed.flags["dry-run"]) {
    console.log("dry-run enabled: generated files only.");
    return;
  }

  await monitor.start();
  monitor.appendEvent(`[bootstrap] interpreted with ${interpreted.sourceAgent}`);
  monitor.appendEvent(`[bootstrap] prompt source ${promptSourcePath ? promptSourcePath : "inline"}`);
  monitor.appendEvent(`[bootstrap] jj preflight passed`);

  const timer = setInterval(() => {
    void monitor.maybeEmitSnapshot(false);
  }, 10_000);

  try {
    const result = await runWorkflowManaged({
      repoRoot,
      smithersCliPath,
      preloadPath: generated.preloadPath,
      workflowPath: generated.workflowPath,
      runId,
      maxConcurrency: maxConcurrencyOverride,
      monitor,
    });

    await monitor.maybeEmitSnapshot(true);

    if (result.code !== 0) {
      const issueFile = await monitor.writeIssueDraftIfNeeded();
      if (issueFile && detectedAgents.gh) {
        const rel = toRepoRelativePath(repoRoot, issueFile);
        console.error(`Issue draft saved: ${rel}`);
        console.error(`Open issue with: gh issue create --title "super-ralph workflow failure (${runId})" --body-file ${shellEscape(rel)}`);
      }

      const statusLabel = result.status ? `status=${result.status}` : "status=unknown";
      throw new Error(`Workflow failed (exit=${result.code}, ${statusLabel})`);
    }

    const issueFile = await monitor.writeIssueDraftIfNeeded();
    if (issueFile) {
      const rel = toRepoRelativePath(repoRoot, issueFile);
      console.log(`Detected recoverable issues. Draft summary: ${rel}`);
      if (detectedAgents.gh) {
        console.log(`Optional: gh issue create --title "super-ralph workflow observations (${runId})" --body-file ${shellEscape(rel)}`);
      }
    }

    console.log("super-ralph workflow finished successfully.");
  } finally {
    clearInterval(timer);
    monitor.stop();
  }
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(detail);
  process.exit(1);
});
