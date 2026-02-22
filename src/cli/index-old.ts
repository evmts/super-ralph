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
import type { ClarificationAnswer, ClarificationSession, ClarificationQuestion } from "./clarifications.ts";
import { getClarificationQuestions, buildAgentClarificationPrompt } from "./clarifications.ts";

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
  --skip-questions                Skip the clarifying questions phase
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
  clarificationSession?: ClarificationSession;
}): string {
  const scriptsBlock = Object.entries(params.packageScripts)
    .map(([name, cmd]) => `- ${name}: ${cmd}`)
    .join("\n");

  const agentBlock = [
    params.detectedAgents.claude ? "- claude CLI available" : "- claude CLI unavailable",
    params.detectedAgents.codex ? "- codex CLI available" : "- codex CLI unavailable",
  ].join("\n");

  const clarificationBlock = params.clarificationSession
    ? [
        "",
        "User Clarifications (CRITICAL - use these to guide all configuration decisions):",
        "The user has answered detailed questions about their workflow preferences.",
        "You MUST incorporate these answers into the configuration.",
        "",
        params.clarificationSession.summary,
        "",
      ].join("\n")
    : "";

  return [
    "You are a workflow-config assistant for super-ralph.",
    "Return ONLY JSON. No markdown, no code fences, no commentary.",
    "",
    "Goal:",
    "Convert the user request into practical SuperRalph configuration fields.",
    params.clarificationSession
      ? "The user has provided detailed clarifications - use them to customize the configuration."
      : "",
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
    params.clarificationSession
      ? "- CRITICAL: Interpret and apply the user's clarification answers to tailor the config."
      : "",
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
    clarificationBlock,
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
  clarificationSession?: ClarificationSession;
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
    clarificationSession: params.clarificationSession,
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

async function promptUser(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return await new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Interactive keyboard-navigable multiple choice selector.
 * Users can use arrow keys to navigate and Enter to select.
 */
async function promptMultipleChoice(params: {
  question: string;
  choices: Array<{ label: string; description: string }>;
  allowCustom?: boolean;
}): Promise<{ index: number; isCustom: boolean; customValue?: string }> {
  return await new Promise((resolve) => {
    let selectedIndex = 0;
    let customInputMode = false;
    let customInputValue = "";
    const totalChoices = params.choices.length + (params.allowCustom ? 1 : 0);

    // Enable raw mode to capture individual keypresses
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const render = () => {
      // Clear screen and move cursor to top
      process.stdout.write("\x1B[2J\x1B[H");

      console.log(`${params.question}\n`);

      for (let i = 0; i < params.choices.length; i++) {
        const choice = params.choices[i];
        const prefix = i === selectedIndex && !customInputMode ? "→ " : "  ";
        const highlight = i === selectedIndex && !customInputMode ? "\x1b[1m\x1b[36m" : "";
        const reset = i === selectedIndex && !customInputMode ? "\x1b[0m" : "";

        console.log(`${highlight}${prefix}${i + 1}. ${choice.label}${reset}`);
        console.log(`     ${choice.description}\n`);
      }

      if (params.allowCustom) {
        const customIndex = params.choices.length;
        const isCustomSelected = customIndex === selectedIndex;
        const prefix = isCustomSelected && !customInputMode ? "→ " : "  ";
        const highlight = isCustomSelected && !customInputMode ? "\x1b[1m\x1b[36m" : "";
        const reset = isCustomSelected && !customInputMode ? "\x1b[0m" : "";

        console.log(`${highlight}${prefix}${customIndex + 1}. Custom Answer${reset}`);
        console.log(`     Write your own answer to this question\n`);

        // Show input box when custom is selected
        if (isCustomSelected || customInputMode) {
          console.log("\x1b[1m\x1b[33m✎ Custom Answer:\x1b[0m");
          console.log(`┌${"─".repeat(78)}┐`);
          console.log(`│ \x1b[36m${customInputValue}\x1b[7m \x1b[0m${" ".repeat(Math.max(0, 76 - customInputValue.length))}│`);
          console.log(`└${"─".repeat(78)}┘`);
        }
      }

      if (customInputMode || (params.allowCustom && selectedIndex === params.choices.length)) {
        console.log("\n\x1b[90mType your answer, Enter to confirm, ↑/↓ to navigate away\x1b[0m");
      } else {
        console.log("\n\x1b[90mUse ↑/↓ arrows to navigate, Enter to select, or type a number (1-" + totalChoices + ")\x1b[0m");
      }
    };

    render();

    const onKeypress = async (key: string) => {
      const isOnCustomOption = params.allowCustom && selectedIndex === params.choices.length;

      // Handle navigation
      if (key === "\u001b[A") {
        // Up arrow
        selectedIndex = (selectedIndex - 1 + totalChoices) % totalChoices;
        // Clear custom input when navigating away
        if (!isOnCustomOption) {
          customInputValue = "";
          customInputMode = false;
        }
        render();
      } else if (key === "\u001b[B") {
        // Down arrow
        selectedIndex = (selectedIndex + 1) % totalChoices;
        // Clear custom input when navigating away
        if (!isOnCustomOption) {
          customInputValue = "";
          customInputMode = false;
        }
        render();
      } else if (key === "\r" || key === "\n") {
        // Enter key
        if (isOnCustomOption) {
          // Confirm custom input
          if (customInputValue.trim()) {
            cleanup();
            resolve({ index: params.choices.length, isCustom: true, customValue: customInputValue.trim() });
          } else {
            // Empty input - enable typing mode
            customInputMode = true;
            render();
          }
        } else {
          // Regular selection
          cleanup();
          resolve({ index: selectedIndex, isCustom: false });
        }
      } else if (key === "\u0003") {
        // Ctrl+C
        cleanup();
        console.log("\n\nInterrupted by user");
        process.exit(1);
      } else if (key === "\u007f" || key === "\b") {
        // Backspace - only when on custom option
        if (isOnCustomOption && customInputValue.length > 0) {
          customInputValue = customInputValue.slice(0, -1);
          customInputMode = true;
          render();
        }
      } else if (key.length === 1 && key >= " " && key <= "~") {
        // Printable character
        const num = parseInt(key, 10);
        if (!isNaN(num) && num >= 1 && num <= totalChoices && !customInputMode) {
          // Number key for quick selection (only if not typing)
          selectedIndex = num - 1;
          customInputValue = "";
          customInputMode = false;
          render();
        } else if (isOnCustomOption) {
          // Type into custom input when on custom option
          customInputValue += key;
          customInputMode = true;
          render();
        }
      }
    };

    const cleanup = () => {
      process.stdin.removeListener("data", onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };

    process.stdin.on("data", onKeypress);
  });
}

function generateClarifyingQuestions(params: {
  promptText: string;
  repoRoot: string;
  packageScripts: Record<string, string>;
  detectedAgents: DetectedAgents;
}): ClarificationQuestion[] {
  // Use the standardized questions from the clarifications module
  return getClarificationQuestions();
}

// Legacy function kept for backwards compatibility but now delegates to the module
function generateClarifyingQuestionsLegacy(params: {
  promptText: string;
  repoRoot: string;
  packageScripts: Record<string, string>;
  detectedAgents: DetectedAgents;
}): ClarificationQuestion[] {
  const hasTests = Object.keys(params.packageScripts).some((key) => key.includes("test"));
  const hasBuild = Object.keys(params.packageScripts).some((key) => key.includes("build"));
  const hasTypecheck = Object.keys(params.packageScripts).some((key) => key.includes("typecheck") || key.includes("type"));

  return [
    {
      question: "What is the primary goal of this workflow?",
      choices: [
        {
          label: "Feature Development",
          description: "Building new features with comprehensive testing and review cycles",
          value: "feature",
        },
        {
          label: "Bug Fixes",
          description: "Fixing existing issues with focused regression testing",
          value: "bugfix",
        },
        {
          label: "Refactoring",
          description: "Code restructuring while maintaining behavior with extensive test coverage",
          value: "refactor",
        },
        {
          label: "Exploration/Research",
          description: "Investigating approaches with lightweight validation and rapid iteration",
          value: "exploration",
        },
      ],
    },
    {
      question: "What level of test coverage is expected?",
      choices: [
        {
          label: "Critical Paths Only",
          description: "Test only the most important user flows and edge cases",
          value: "critical",
        },
        {
          label: "Standard Coverage",
          description: "Test all modified functions and their direct dependencies",
          value: "standard",
        },
        {
          label: "Comprehensive",
          description: "Test all affected code paths including indirect dependencies and integrations",
          value: "comprehensive",
        },
        {
          label: "Minimal",
          description: "Light smoke tests only, prioritize speed over coverage",
          value: "minimal",
        },
      ],
    },
    {
      question: "How should code review be conducted?",
      choices: [
        {
          label: "Strict",
          description: "Multiple review rounds with detailed checklist validation and architectural scrutiny",
          value: "strict",
        },
        {
          label: "Standard",
          description: "Single thorough review focusing on correctness and spec compliance",
          value: "standard",
        },
        {
          label: "Lightweight",
          description: "Quick review for obvious issues and style consistency",
          value: "lightweight",
        },
        {
          label: "Auto-merge",
          description: "Skip manual review if automated checks pass (use with caution)",
          value: "auto",
        },
      ],
    },
    {
      question: "What is your preferred development velocity?",
      choices: [
        {
          label: "Rapid Iteration",
          description: "Fast cycles with higher concurrency, accepting some technical debt for speed",
          value: "rapid",
        },
        {
          label: "Balanced",
          description: "Moderate pace balancing speed with quality and maintainability",
          value: "balanced",
        },
        {
          label: "Deliberate",
          description: "Slower, methodical approach with thorough validation at each step",
          value: "deliberate",
        },
        {
          label: "Maximum Speed",
          description: "Highest concurrency, minimal checks, move fast and fix issues later",
          value: "maximum",
        },
      ],
    },
    {
      question: "How should pre-landing validation work?",
      choices: [
        {
          label: "Full Suite",
          description: "Run all builds, typechecks, lints, and tests before allowing merge",
          value: "full",
        },
        {
          label: "Essential Only",
          description: "Run only critical checks (typecheck + essential tests)",
          value: "essential",
        },
        {
          label: "Typecheck Only",
          description: "Just verify types compile, skip other validations for speed",
          value: "typecheck",
        },
        {
          label: "Skip Validation",
          description: "Trust the implementation, validate post-merge instead",
          value: "skip",
        },
      ],
    },
    {
      question: "What post-landing validation is needed?",
      choices: [
        {
          label: "Full Test Suite",
          description: "Run complete test suite after merge to catch integration issues",
          value: "full-tests",
        },
        {
          label: "Integration Tests",
          description: "Run integration and E2E tests only, skip unit tests",
          value: "integration",
        },
        {
          label: "Smoke Tests",
          description: "Quick validation that critical paths still work",
          value: "smoke",
        },
        {
          label: "None",
          description: "Skip post-merge validation entirely",
          value: "none",
        },
      ],
    },
    {
      question: "How should the workflow handle failures?",
      choices: [
        {
          label: "Retry Aggressively",
          description: "Retry failed tasks up to 5 times with exponential backoff before giving up",
          value: "aggressive",
        },
        {
          label: "Standard Retry",
          description: "Retry failed tasks 2-3 times then surface errors for manual intervention",
          value: "standard",
        },
        {
          label: "Fail Fast",
          description: "Stop immediately on first failure for quick debugging",
          value: "fail-fast",
        },
        {
          label: "Continue on Error",
          description: "Log failures but continue processing other tasks when possible",
          value: "continue",
        },
      ],
    },
    {
      question: "What architectural areas should receive focus?",
      choices: [
        {
          label: "Auto-detect",
          description: "Let the AI analyze the codebase and determine appropriate focus areas",
          value: "auto",
        },
        {
          label: "Frontend Heavy",
          description: "Prioritize UI components, state management, and user interactions",
          value: "frontend",
        },
        {
          label: "Backend Heavy",
          description: "Focus on APIs, data models, business logic, and infrastructure",
          value: "backend",
        },
        {
          label: "Full Stack",
          description: "Balanced attention across all architectural layers",
          value: "fullstack",
        },
      ],
    },
    {
      question: "How should spec compliance be verified?",
      choices: [
        {
          label: "Strict Compliance",
          description: "Block merge if any spec requirement is not fully addressed",
          value: "strict",
        },
        {
          label: "Best Effort",
          description: "Aim for spec compliance but allow pragmatic deviations with justification",
          value: "best-effort",
        },
        {
          label: "Advisory Only",
          description: "Treat specs as guidelines, focus on working software over documentation",
          value: "advisory",
        },
        {
          label: "Interpret Liberally",
          description: "Allow creative interpretation of requirements based on discovered constraints",
          value: "liberal",
        },
      ],
    },
    {
      question: "What documentation updates are required?",
      choices: [
        {
          label: "Comprehensive",
          description: "Update all relevant docs including API references, guides, and inline comments",
          value: "comprehensive",
        },
        {
          label: "API Changes Only",
          description: "Document public API changes and breaking changes only",
          value: "api-only",
        },
        {
          label: "Inline Comments",
          description: "Add code comments for complex logic but skip external documentation",
          value: "inline",
        },
        {
          label: "Self-Documenting",
          description: "Rely on clear code structure and naming, minimize explicit documentation",
          value: "self-documenting",
        },
      ],
    },
    {
      question: "How should the merge queue be prioritized?",
      choices: [
        {
          label: "FIFO (First In, First Out)",
          description: "Process tickets in the order they were completed, ensuring fairness",
          value: "fifo",
        },
        {
          label: "Priority-Based",
          description: "High-priority tickets jump the queue, critical fixes land first",
          value: "priority",
        },
        {
          label: "Risk-Sorted",
          description: "Merge low-risk changes first, batch risky changes together",
          value: "risk",
        },
        {
          label: "Dependency-Aware",
          description: "Merge foundation tickets before dependent work regardless of completion order",
          value: "dependency",
        },
      ],
    },
    {
      question: "What level of speculative execution is acceptable?",
      choices: [
        {
          label: "Conservative (Depth 1-2)",
          description: "Only start obviously safe follow-up work, minimize wasted effort on blocked paths",
          value: "conservative",
        },
        {
          label: "Moderate (Depth 3-4)",
          description: "Speculatively start likely tasks but avoid deep chains of assumptions",
          value: "moderate",
        },
        {
          label: "Aggressive (Depth 5+)",
          description: "Maximize parallelism by starting all plausible work, accept some rollback cost",
          value: "aggressive",
        },
        {
          label: "Disabled",
          description: "No speculation, only work on tasks with all dependencies satisfied",
          value: "disabled",
        },
      ],
    },
  ];
}

async function generateQuestionsWithAgent(params: {
  smithers: SmithersModule;
  promptText: string;
  repoRoot: string;
  packageScripts: Record<string, string>;
  detectedAgents: DetectedAgents;
}): Promise<ClarificationQuestion[]> {
  const scriptsBlock = Object.entries(params.packageScripts)
    .map(([name, cmd]) => `- ${name}: ${cmd}`)
    .join("\n");

  const prompt = `You are a workflow configuration assistant for Super Ralph.

Your task: Generate 10-15 clarifying questions to help customize a development workflow.

Context:
- User's request: ${params.promptText}
- Repository: ${params.repoRoot}
- Available scripts: ${scriptsBlock || "(none)"}
- Available agents: claude=${params.detectedAgents.claude}, codex=${params.detectedAgents.codex}

Generate questions that are:
1. SPECIFIC to the user's request (not generic)
2. Help determine workflow behavior, testing strategy, review process, etc.
3. Each question has 4 distinct choices with clear descriptions
4. Choices should be realistic options for this specific task

Return ONLY valid JSON in this exact format:
{
  "questions": [
    {
      "question": "How should X be handled for this task?",
      "choices": [
        {
          "label": "Option A",
          "description": "Clear explanation of what this means and when to use it",
          "value": "option-a"
        },
        {
          "label": "Option B",
          "description": "Clear explanation of what this means and when to use it",
          "value": "option-b"
        },
        {
          "label": "Option C",
          "description": "Clear explanation of what this means and when to use it",
          "value": "option-c"
        },
        {
          "label": "Option D",
          "description": "Clear explanation of what this means and when to use it",
          "value": "option-d"
        }
      ]
    }
  ]
}

Guidelines:
- Ask about test coverage appropriate for this task
- Ask about code review rigor
- Ask about development velocity preferences
- Ask about validation strategy (pre/post merge)
- Ask about failure handling
- Ask about documentation needs
- Ask about architectural focus areas relevant to the request
- Ask about merge/deployment strategy
- Make each question relevant to "${params.promptText}"

Return valid JSON only, no markdown, no explanations.`;

  const agentSpecs = await createInterpreterAgents(params.smithers, params.repoRoot, params.detectedAgents);
  if (agentSpecs.length === 0) {
    // Fallback to hardcoded questions if no agent available
    console.warn("No agent available for generating questions, using defaults...");
    return getClarificationQuestions();
  }

  console.log("Generating contextual questions based on your request...\n");

  for (const spec of agentSpecs) {
    try {
      const result = await spec.agent.generate({
        prompt,
        timeout: { totalMs: 60 * 1000 },
      });

      const decoded = coerceInterpreterPayload(decodeInterpreterResult(result));
      if (!decoded || typeof decoded !== "object") {
        continue;
      }

      const data = decoded as any;
      const questions = data.questions || data;

      if (Array.isArray(questions) && questions.length > 0) {
        // Validate and return questions
        const validated = questions.filter((q: any) =>
          q.question &&
          Array.isArray(q.choices) &&
          q.choices.length >= 4 &&
          q.choices.every((c: any) => c.label && c.description && c.value)
        );

        if (validated.length >= 10) {
          console.log(`✓ Generated ${validated.length} contextual questions\n`);
          return validated;
        }
      }
    } catch (error) {
      console.warn(`Failed to generate questions with ${spec.name}:`, error instanceof Error ? error.message : String(error));
    }
  }

  // Fallback to hardcoded questions
  console.warn("Could not generate custom questions, using defaults...\n");
  return getClarificationQuestions();
}

async function runClarifyingQuestions(params: {
  smithers: SmithersModule;
  promptText: string;
  repoRoot: string;
  packageScripts: Record<string, string>;
  detectedAgents: DetectedAgents;
}): Promise<ClarificationSession> {
  // Generate questions using an agent
  const questions = await generateQuestionsWithAgent(params);
  const answers: ClarificationAnswer[] = [];

  console.log("\n" + "=".repeat(80));
  console.log("SUPER RALPH CLARIFYING QUESTIONS");
  console.log("=".repeat(80));
  console.log("\nPlease answer the following questions to customize your workflow.");
  console.log("Use arrow keys to navigate, Enter to select, or type a number.\n");

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];

    // Use keyboard-navigable prompt
    const result = await promptMultipleChoice({
      question: `[Question ${i + 1}/${questions.length}] ${q.question}`,
      choices: q.choices,
      allowCustom: true,
    });

    let answer = "";
    let isCustom = result.isCustom;

    if (result.isCustom && result.customValue) {
      answer = result.customValue;
    } else {
      const selected = q.choices[result.index];
      answer = `${selected.label}: ${selected.description}`;
    }

    // Clear screen and show confirmation
    process.stdout.write("\x1B[2J\x1B[H");
    console.log(`\n[Question ${i + 1}/${questions.length}] ${q.question}`);
    console.log(`✓ Selected: ${isCustom ? "Custom - " + answer : q.choices[result.index].label}\n`);

    // Brief pause to show selection
    await new Promise((resolve) => setTimeout(resolve, 800));

    answers.push({
      question: q.question,
      answer,
      isCustom,
    });
  }

  // Clear screen and show summary
  process.stdout.write("\x1B[2J\x1B[H");
  console.log("\n" + "=".repeat(80));
  console.log("CLARIFICATION COMPLETE");
  console.log("=".repeat(80) + "\n");

  const summary = answers
    .map((a, i) => `${i + 1}. ${a.question}\n   → ${a.answer}`)
    .join("\n\n");

  console.log("Your answers:\n");
  console.log(summary);
  console.log("");

  return {
    answers,
    summary,
  };
}

/**
 * Generate a tool schema that AI agents can use to gather workflow clarifications.
 * This allows agents to programmatically ask the same questions during workflow generation.
 */
function buildClarificationToolPrompt(params: {
  promptText: string;
  repoRoot: string;
  packageScripts: Record<string, string>;
  detectedAgents: DetectedAgents;
}): string {
  const questions = generateClarifyingQuestions(params);

  const questionsBlock = questions
    .map((q, i) => {
      const choicesBlock = q.choices
        .map((c, j) => `    ${j + 1}. ${c.label}: ${c.description}`)
        .join("\n");
      return `${i + 1}. ${q.question}\n${choicesBlock}\n    5. Custom: (User provides their own answer)`;
    })
    .join("\n\n");

  return `
# Super Ralph Workflow Clarification Questions

You are helping configure a Super Ralph workflow. Ask the user the following questions to gather preferences.
For each question, present the choices and accept either:
- A number (1-5) to select a preset
- Custom text if they choose option 5

## Questions to Ask:

${questionsBlock}

## Instructions:
1. Ask each question sequentially
2. Present all 5 options clearly with their descriptions
3. Accept the user's choice and record it
4. After all questions are answered, provide a summary
5. Use the answers to inform the workflow configuration

## Output Format:
After gathering all answers, provide them in this JSON structure:
{
  "answers": [
    {
      "question": "...",
      "answer": "...",
      "isCustom": false
    }
  ],
  "summary": "1. Question1\\n   → Answer1\\n\\n2. Question2\\n   → Answer2..."
}
`.trim();
}

async function writeGeneratedFiles(params: {
  repoRoot: string;
  generatedDir: string;
  promptText: string;
  config: SuperRalphCliConfig;
  hasClaude: boolean;
  hasCodex: boolean;
  clarificationSession?: ClarificationSession;
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

  // Run clarifying questions unless --skip-questions is set
  let clarificationSession: ClarificationSession | undefined;
  if (!parsed.flags["skip-questions"]) {
    const packageScripts = await loadPackageScripts(repoRoot);
    clarificationSession = await runClarifyingQuestions({
      smithers,
      promptText,
      repoRoot,
      packageScripts,
      detectedAgents,
    });

    // Save clarification session to disk
    const clarificationPath = join(generatedDir, "clarifications.json");
    await writeFile(clarificationPath, JSON.stringify(clarificationSession, null, 2), "utf8");
    console.log(`Clarifications saved to: ${toRepoRelativePath(repoRoot, clarificationPath)}\n`);
  } else {
    console.log("Skipping clarifying questions (--skip-questions flag set)\n");
  }

  const interpreted = await interpretPromptConfig({
    smithers,
    repoRoot,
    promptText,
    promptSpecPath,
    promptSourcePath,
    detectedAgents,
    fallbackConfig,
    clarificationSession,
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
    clarificationSession,
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
