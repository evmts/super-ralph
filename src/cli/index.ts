#!/usr/bin/env bun
/**
 * Super Ralph CLI - Smithers Workflow Edition
 *
 * This CLI generates and executes a full Smithers workflow where ALL AI interactions
 * happen through the Smithers orchestration tree.
 *
 * Architecture:
 * 1. ClarifyingQuestions component generates and collects user preferences
 * 2. InterpretConfig component converts preferences into SuperRalph configuration
 * 3. SuperRalph + Monitor run in parallel to execute the workflow with live monitoring
 *
 * Everything is orchestrated through Smithers, providing:
 * - Resumability (can restart from any step)
 * - Observability (all state in database)
 * - Consistent agent coordination
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getClarificationQuestions } from "./clarifications.ts";

type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

function printHelp() {
  console.log(`Super Ralph - Smithers Workflow Edition

Usage:
  super-ralph "prompt text"
  super-ralph ./PROMPT.md

Options:
  --cwd <path>                    Repo root (default: current directory)
  --max-concurrency <n>           Workflow max concurrency override
  --run-id <id>                   Explicit Smithers run id
  --dry-run                       Generate workflow files but do not execute
  --skip-questions                Skip the clarifying questions phase
  --help                          Show this help

Examples:
  super-ralph "Build a React todo app"
  super-ralph ./specs/feature.md --max-concurrency 8
  super-ralph "Add authentication" --skip-questions
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

async function commandExists(command: string, cwd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", command], { cwd, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

async function detectAgents(repoRoot: string): Promise<{ claude: boolean; codex: boolean; gh: boolean }> {
  const [claude, codex, gh] = await Promise.all([
    commandExists("claude", repoRoot),
    commandExists("codex", repoRoot),
    commandExists("gh", repoRoot),
  ]);

  return { claude, codex, gh };
}

function buildFallbackConfig(repoRoot: string, promptSpecPath: string, packageScripts: Record<string, string>) {
  const runner = detectScriptRunner(repoRoot);

  const buildCmds: Record<string, string> = {};
  const testCmds: Record<string, string> = {};

  if (packageScripts.typecheck) {
    buildCmds.typecheck = scriptCommand(runner, "typecheck");
  }
  if (packageScripts.build) {
    buildCmds.build = scriptCommand(runner, "build");
  }
  if (packageScripts.lint) {
    buildCmds.lint = scriptCommand(runner, "lint");
  }

  if (packageScripts.test) {
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
  const maxConcurrency = Math.min(Math.max(Number(process.env.WORKFLOW_MAX_CONCURRENCY ?? "6") || 6, 1), 32);

  return {
    projectName,
    projectId: slugify(projectName),
    focuses: [
      { id: "core", name: "Core Platform" },
      { id: "api", name: "API and Data" },
      { id: "workflow", name: "Workflow and Automation" },
    ],
    specsPath: chosenSpecs,
    referenceFiles: [
      promptSpecPath,
      existsSync(join(repoRoot, "README.md")) ? "README.md" : "",
      existsSync(join(repoRoot, "docs")) ? "docs" : "",
    ].filter(Boolean),
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

function findSmithersCliPath(repoRoot: string): string | null {
  const candidates = [
    join(repoRoot, "node_modules/smithers-orchestrator/src/cli/index.ts"),
    resolve(dirname(import.meta.path), "../../node_modules/smithers-orchestrator/src/cli/index.ts"),
    join(process.env.HOME || "", "smithers/src/cli/index.ts"),
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
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

function renderWorkflowFile(params: {
  promptText: string;
  promptSpecPath: string;
  repoRoot: string;
  dbPath: string;
  packageScripts: Record<string, string>;
  detectedAgents: { claude: boolean; codex: boolean };
  fallbackConfig: any;
  skipQuestions: boolean;
}): string {
  const { promptText, promptSpecPath, repoRoot, dbPath, packageScripts, detectedAgents, fallbackConfig, skipQuestions } = params;

  // Determine import strategy:
  // If target repo is super-ralph itself, use relative imports
  // If running from super-ralph source for another repo, use absolute paths to source
  // Otherwise, use package imports
  const isSuperRalphRepo = existsSync(join(repoRoot, 'src/components/SuperRalph.tsx')) &&
                           existsSync(join(repoRoot, 'src/components/ClarifyingQuestions.tsx'));

  // Check if we're running from super-ralph source (CLI location)
  const cliDir = import.meta.dir || dirname(fileURLToPath(import.meta.url));
  const superRalphSourceRoot = dirname(dirname(cliDir));
  const runningFromSource = existsSync(join(superRalphSourceRoot, 'src/components/SuperRalph.tsx'));

  let importPrefix: string;
  if (isSuperRalphRepo) {
    // Generating workflow IN super-ralph repo - use relative imports
    importPrefix = '../../src';
  } else if (runningFromSource) {
    // Running from super-ralph source for another repo - use absolute imports to source
    importPrefix = superRalphSourceRoot + '/src';
  } else {
    // Running from installed package
    importPrefix = 'super-ralph';
  }

  return `import React from "react";
import { createSmithers, ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";
import { SuperRalph } from "${importPrefix}";
import {
  ClarifyingQuestions,
  InterpretConfig,
  Monitor,
  clarifyingQuestionsOutputSchema,
  interpretConfigOutputSchema,
  monitorOutputSchema,
} from "${importPrefix}/components";
import { getClarificationQuestions } from "${importPrefix}/cli/clarifications";

const REPO_ROOT = ${JSON.stringify(repoRoot)};
const DB_PATH = ${JSON.stringify(dbPath)};
const HAS_CLAUDE = ${detectedAgents.claude};
const HAS_CODEX = ${detectedAgents.codex};
const PROMPT_TEXT = ${JSON.stringify(promptText)};
const PROMPT_SPEC_PATH = ${JSON.stringify(promptSpecPath)};
const PACKAGE_SCRIPTS = ${JSON.stringify(packageScripts, null, 2)};
const FALLBACK_CONFIG = ${JSON.stringify(fallbackConfig, null, 2)};
const SKIP_QUESTIONS = ${skipQuestions};

const { smithers, outputs, Workflow, Sequence, Parallel } = createSmithers(
  {
    clarifying_questions: clarifyingQuestionsOutputSchema,
    interpret_config: interpretConfigOutputSchema,
    monitor: monitorOutputSchema,
  },
  { dbPath: DB_PATH }
);

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

const planningAgent = choose("claude", "Plan and research next tickets.");
const implementationAgent = choose("claude", "Implement with test-driven development and jj workflows.");
const testingAgent = choose("claude", "Run tests and validate behavior changes.");
const reviewingAgent = choose("codex", "Review for regressions, spec drift, and correctness.");
const reportingAgent = choose("claude", "Write concise, accurate ticket status reports.");

export default smithers((ctx) => (
  <Workflow name="super-ralph-full">
    <Sequence>
      {/* Step 1: Clarifying Questions (skip if --skip-questions) */}
      {!SKIP_QUESTIONS && (
        <ClarifyingQuestions
          ctx={ctx}
          outputs={outputs}
          prompt={PROMPT_TEXT}
          repoRoot={REPO_ROOT}
          packageScripts={PACKAGE_SCRIPTS}
          agent={planningAgent}
          preGeneratedQuestions={getClarificationQuestions()}
        />
      )}

      {/* Step 2: Interpret Config */}
      <InterpretConfig
        prompt={PROMPT_TEXT}
        clarificationSession={
          SKIP_QUESTIONS
            ? null
            : (ctx.outputMaybe("collect-clarification-answers", outputs.clarifying_questions) as any)?.session ?? null
        }
        repoRoot={REPO_ROOT}
        fallbackConfig={FALLBACK_CONFIG}
        packageScripts={PACKAGE_SCRIPTS}
        detectedAgents={{
          claude: HAS_CLAUDE,
          codex: HAS_CODEX,
          gh: false, // Not used in config interpretation
        }}
        agent={planningAgent}
      />

      {/* Step 3: Run SuperRalph + Monitor in Parallel */}
      <Parallel>
        <SuperRalph
          ctx={ctx}
          outputs={outputs}
          {...((ctx.outputMaybe("interpret-config", outputs.interpret_config) as any) || FALLBACK_CONFIG)}
          agents={{
            planning: planningAgent,
            implementation: implementationAgent,
            testing: testingAgent,
            reviewing: reviewingAgent,
            reporting: reportingAgent,
          }}
        />

        <Monitor
          dbPath={DB_PATH}
          runId={ctx.runId}
          config={(ctx.outputMaybe("interpret-config", outputs.interpret_config) as any) || FALLBACK_CONFIG}
          clarificationSession={
            SKIP_QUESTIONS
              ? null
              : (ctx.outputMaybe("collect-clarification-answers", outputs.clarifying_questions) as any)?.session ?? null
          }
          prompt={PROMPT_TEXT}
          repoRoot={REPO_ROOT}
        />
      </Parallel>
    </Sequence>
  </Workflow>
));
`;
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

  console.log("🚀 Super Ralph - Smithers Workflow Edition\n");

  await ensureJjAvailable(repoRoot);

  const smithersCliPath = findSmithersCliPath(repoRoot);
  if (!smithersCliPath) {
    throw new Error(
      "Could not find smithers CLI. Install smithers-orchestrator in this repo:\n  bun add smithers-orchestrator",
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
  const packageScripts = await loadPackageScripts(repoRoot);
  const fallbackConfig = buildFallbackConfig(repoRoot, promptSpecPath, packageScripts);

  // Write prompt to file
  await writeFile(promptSpecPath, `${promptText.trim()}\n`, "utf8");

  // Generate workflow file
  const workflowPath = join(generatedDir, "workflow.tsx");
  const preloadPath = join(generatedDir, "preload.ts");
  const bunfigPath = join(generatedDir, "bunfig.toml");
  const dbPath = join(repoRoot, ".super-ralph/workflow.db");

  const workflowSource = renderWorkflowFile({
    promptText,
    promptSpecPath,
    repoRoot,
    dbPath,
    packageScripts,
    detectedAgents: { claude: detectedAgents.claude, codex: detectedAgents.codex },
    fallbackConfig,
    skipQuestions: Boolean(parsed.flags["skip-questions"]),
  });

  await writeFile(workflowPath, workflowSource, "utf8");

  // Create preload - check if we have a shared preload from super-ralph source
  const cliDir = import.meta.dir || dirname(fileURLToPath(import.meta.url));
  const superRalphRoot = dirname(dirname(cliDir)); // Go up from src/cli to super-ralph root
  const superRalphPreload = join(superRalphRoot, "preload.ts");
  const useSharedPreload = existsSync(superRalphPreload);

  if (!useSharedPreload) {
    await writeFile(
      preloadPath,
      `import { mdxPlugin } from "smithers-orchestrator/mdx-plugin";\n\nmdxPlugin();\n`,
      "utf8",
    );
  }

  await writeFile(bunfigPath, `preload = ["./preload.ts"]\n`, "utf8");

  const runId = typeof parsed.flags["run-id"] === "string"
    ? String(parsed.flags["run-id"])
    : `sr-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

  const maxConcurrencyOverride = typeof parsed.flags["max-concurrency"] === "string"
    ? Math.max(1, Number(parsed.flags["max-concurrency"]) || fallbackConfig.maxConcurrency)
    : fallbackConfig.maxConcurrency;

  console.log(`📁 Repo: ${repoRoot}`);
  console.log(`📝 Prompt: ${promptSourcePath || "inline"}`);
  console.log(`🔧 Workflow: ${workflowPath}`);
  console.log(`💾 Database: ${dbPath}`);
  console.log(`🆔 Run ID: ${runId}`);
  console.log(`🤖 Agents: claude=${detectedAgents.claude} codex=${detectedAgents.codex} gh=${detectedAgents.gh}`);
  console.log(`⚡ Concurrency: ${maxConcurrencyOverride}\n`);

  if (parsed.flags["dry-run"]) {
    console.log("✅ Dry run complete. Workflow files generated but not executed.\n");
    return;
  }

  console.log("🎬 Starting workflow execution...\n");

  // Execute the workflow using Smithers CLI
  // Determine execution directory: use smithers directory for node_modules access
  const smithersDir = dirname(dirname(smithersCliPath)); // Go up from src/cli to smithers root
  const execCwd = existsSync(join(smithersDir, "node_modules")) ? smithersDir : repoRoot;

  // Use the preload that's in the directory with node_modules
  const effectivePreload = useSharedPreload ? superRalphPreload : preloadPath;

  const args = [
    "-r",
    effectivePreload,
    smithersCliPath,
    "run",
    workflowPath,
    "--root",
    repoRoot,
    "--run-id",
    runId,
    "--max-concurrency",
    String(maxConcurrencyOverride),
  ];

  const env = { ...process.env, USE_CLI_AGENTS: "1", SMITHERS_DEBUG: "1" };
  delete (env as any).CLAUDECODE;

  const proc = Bun.spawn(["bun", ...args], {
    cwd: execCwd,
    env: env as any,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  const exitCode = await proc.exited;

  if (exitCode === 0) {
    console.log("\n✅ Super Ralph workflow completed successfully!\n");
  } else {
    console.error(`\n❌ Workflow exited with code ${exitCode}\n`);
    process.exit(exitCode);
  }
}

main().catch((error) => {
  console.error("\n❌ Error:", error.message);
  process.exit(1);
});
