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

// Check if we're running from super-ralph source (CLI location)
// These need to be at module level so they're accessible in both renderWorkflowFile and main execution
const cliDir = import.meta.dir || dirname(fileURLToPath(import.meta.url));
const superRalphSourceRoot = dirname(dirname(cliDir));
const runningFromSource = existsSync(join(superRalphSourceRoot, 'src/components/SuperRalph.tsx'));

function renderWorkflowFile(params: {
  promptText: string;
  promptSpecPath: string;
  repoRoot: string;
  dbPath: string;
  packageScripts: Record<string, string>;
  detectedAgents: { claude: boolean; codex: boolean };
  fallbackConfig: any;
  clarificationSession: any | null;
}): string {
  const { promptText, promptSpecPath, repoRoot, dbPath, packageScripts, detectedAgents, fallbackConfig, clarificationSession } = params;

  // Determine import strategy:
  // If target repo is super-ralph itself, use relative imports
  // If running from super-ralph source for another repo, use absolute paths to source
  // Otherwise, use package imports
  const isSuperRalphRepo = existsSync(join(repoRoot, 'src/components/SuperRalph.tsx')) &&
                           existsSync(join(repoRoot, 'src/components/ClarifyingQuestions.tsx'));

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
import { createSmithers, ClaudeCodeAgent, CodexAgent, Sequence, Parallel } from "smithers-orchestrator";
import { SuperRalph } from "${importPrefix}";
import { InterpretConfig, Monitor } from "${importPrefix}/components";
import { ralphOutputSchemas } from "${importPrefix}";

const REPO_ROOT = ${JSON.stringify(repoRoot)};
const DB_PATH = ${JSON.stringify(dbPath)};
const HAS_CLAUDE = ${detectedAgents.claude};
const HAS_CODEX = ${detectedAgents.codex};
const PROMPT_TEXT = ${JSON.stringify(promptText)};
const PROMPT_SPEC_PATH = ${JSON.stringify(promptSpecPath)};
const PACKAGE_SCRIPTS = ${JSON.stringify(packageScripts, null, 2)};
const FALLBACK_CONFIG = ${JSON.stringify(fallbackConfig, null, 2)};
const CLARIFICATION_SESSION = ${JSON.stringify(clarificationSession)};

const { smithers, outputs, Workflow } = createSmithers(
  ralphOutputSchemas,
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
  if (primary === "claude" && HAS_CLAUDE) return createClaude(systemPrompt);
  if (primary === "codex" && HAS_CODEX) return createCodex(systemPrompt);
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
      {/* Step 1: Interpret Config (clarification session already collected by CLI) */}
      <InterpretConfig
        prompt={PROMPT_TEXT}
        clarificationSession={CLARIFICATION_SESSION}
        repoRoot={REPO_ROOT}
        fallbackConfig={FALLBACK_CONFIG}
        packageScripts={PACKAGE_SCRIPTS}
        detectedAgents={{
          claude: HAS_CLAUDE,
          codex: HAS_CODEX,
          gh: false,
        }}
        agent={planningAgent}
      />

      {/* Step 2: Run SuperRalph + Monitor in Parallel */}
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
          clarificationSession={CLARIFICATION_SESSION}
          prompt={PROMPT_TEXT}
          repoRoot={REPO_ROOT}
        />
      </Parallel>
    </Sequence>
  </Workflow>
));
`;
}

/**
 * Generate clarifying questions via claude --print, then launch the interactive UI.
 * Returns the completed ClarificationSession or null on failure.
 */
async function runClarifyingQuestions(
  promptText: string,
  repoRoot: string,
  packageScripts: Record<string, string>,
): Promise<any> {
  const scriptsBlock = Object.entries(packageScripts)
    .map(([name, cmd]) => `- ${name}: ${cmd}`)
    .join("\n");

  const questionGenPrompt = `You are a senior product consultant helping a user define exactly what they want before a team of AI agents spends hours or even days building it. This is a long-running, expensive automated workflow — getting the requirements right NOW saves enormous time and cost later.

The user may not fully know what they want yet. That's normal. Your job is to:
- Help them think through what they actually need (not just what they said)
- Surface edge cases and decisions they haven't considered
- Make opinionated suggestions when choices have clear best practices
- Ask about scope, priorities, and tradeoffs — not technical implementation

User's request: "${promptText}"
Repository: ${repoRoot}
Available scripts: ${scriptsBlock || "(none)"}

Generate 10-15 clarifying questions. Be thorough — this is the user's only chance to steer the project before autonomous agents take over for a potentially multi-hour or multi-day build.

Focus areas:
- Core features and behavior (what does the user actually see and do?)
- Scope and MVP boundaries (what's in v1 vs later?)
- User experience details (loading states, error handling, empty states)
- Data and persistence (what gets saved, where, for how long?)
- Edge cases the user hasn't thought about
- Priorities and tradeoffs (speed vs polish, features vs simplicity)
- Success criteria (how do we know it's done?)

GOOD questions (product-focused, opinionated):
- "Should todos persist between browser sessions, or is in-memory fine for a demo?"
- "What happens when the list is empty — blank screen, or a friendly prompt?"
- "Is this a quick prototype or something you'd ship to real users?"

BAD questions (tech decisions — NEVER ask these, the AI agents decide):
- "What state management library should we use?"
- "Should we use TypeScript or JavaScript?"
- "What testing framework do you prefer?"

Each question should have 2-6 choices — use as many as make sense for that question. Some questions are yes/no (2 choices), others need more nuance (5-6). Make the choices opinionated — the first choice should be your recommended default for most users. The user can always type a custom answer too.

Return ONLY valid JSON (no markdown fences, no commentary):
{"questions":[{"question":"...","choices":[{"label":"...","description":"...","value":"..."},{"label":"...","description":"...","value":"..."},{"label":"...","description":"...","value":"..."},{"label":"...","description":"...","value":"..."}]}]}`;

  // Call Anthropic API directly for fast question generation
  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinIdx = 0;
  const spinInterval = setInterval(() => {
    process.stdout.write(`\r${spinner[spinIdx++ % spinner.length]} Generating clarifying questions...`);
  }, 80);

  let claudeResult: string;
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("no-api-key");

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: questionGenPrompt }],
      }),
    });

    clearInterval(spinInterval);
    process.stdout.write("\r\x1b[K");

    if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text()}`);
    const data = await resp.json() as any;
    claudeResult = data.content?.[0]?.text ?? "";
    if (!claudeResult.trim()) throw new Error("Empty API response");
  } catch (apiErr: any) {
    clearInterval(spinInterval);
    process.stdout.write("\r\x1b[K");

    // Fallback to claude --print if API call fails (e.g. no API key)
    console.log("⚠️  API call failed, falling back to claude CLI...\n");
    const claudeEnv = { ...process.env, ANTHROPIC_API_KEY: "" };
    delete (claudeEnv as any).CLAUDECODE;
    const fallbackProc = Bun.spawn([
      "claude", "--print", "--output-format", "text", "--model", "claude-opus-4-6",
      questionGenPrompt,
    ], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: claudeEnv,
    });
    const fallbackOut = await new Response(fallbackProc.stdout).text();
    const fallbackErr = await new Response(fallbackProc.stderr).text();
    const fallbackCode = await fallbackProc.exited;
    if (fallbackCode !== 0 || !fallbackOut.trim()) {
      throw new Error(`claude --print failed (code ${fallbackCode}): ${fallbackErr}`);
    }
    claudeResult = fallbackOut.trim();
  }

  // Parse the JSON response — extract JSON from possible markdown fences
  let questions: any[];
  try {
    let jsonStr = claudeResult;
    // Strip markdown code fences if present
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) jsonStr = fenceMatch[1];
    const parsed = JSON.parse(jsonStr.trim());
    questions = parsed.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error("No questions in response");
    }
  } catch (e: any) {
    console.error("⚠️  Failed to parse generated questions, using fallback.");
    // Import hardcoded fallback
    const { getClarificationQuestions } = await import("./clarifications.ts");
    questions = getClarificationQuestions();
  }

  console.log(`✅ Generated ${questions.length} questions\n`);

  // Write questions to temp file and launch interactive UI
  const tempDir = join(repoRoot, ".super-ralph", "temp");
  await mkdir(tempDir, { recursive: true });

  const sessionId = randomUUID();
  const questionsPath = join(tempDir, `questions-${sessionId}.json`);
  const answersPath = join(tempDir, `answers-${sessionId}.json`);

  await writeFile(questionsPath, JSON.stringify({ questions }, null, 2));

  // Launch interactive UI
  const interactiveScript = join(cliDir, "interactive-questions.ts");
  const uiProc = Bun.spawn(["bun", interactiveScript, questionsPath, answersPath], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    cwd: repoRoot,
  });
  const uiCode = await uiProc.exited;
  if (uiCode !== 0) {
    throw new Error(`Interactive UI exited with code ${uiCode}`);
  }

  // Read answers
  const answersJson = await readFile(answersPath, "utf8");
  const { answers } = JSON.parse(answersJson);

  // Build session
  const summary = answers
    .map((a: any, i: number) => `${i + 1}. ${a.question}\n   → ${a.answer}`)
    .join("\n\n");

  // Cleanup temp files
  try {
    const { unlink } = await import("node:fs/promises");
    await Promise.all([unlink(questionsPath), unlink(answersPath)]);
  } catch { /* ignore */ }

  return { answers, summary };
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

  // Step 1: Clarifying questions (unless --skip-questions)
  let clarificationSession: any = null;
  if (!parsed.flags["skip-questions"]) {
    clarificationSession = await runClarifyingQuestions(promptText, repoRoot, packageScripts);
  }

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
    clarificationSession,
  });

  await writeFile(workflowPath, workflowSource, "utf8");

  // Ensure the generated workflow can resolve node_modules (smithers-orchestrator, react, etc.)
  // Bun resolves imports relative to the source file, so we symlink node_modules into the generated dir
  const generatedNodeModules = join(generatedDir, "node_modules");
  const sourceNodeModules = join(superRalphSourceRoot, "node_modules");
  if (!existsSync(generatedNodeModules) && existsSync(sourceNodeModules)) {
    const { symlinkSync } = await import("fs");
    try {
      symlinkSync(sourceNodeModules, generatedNodeModules, "dir");
    } catch {
      // Symlink may already exist or fail on some systems - not fatal
    }
  }

  // Create preload - check if we have a shared preload from super-ralph source
  const superRalphPreload = join(superRalphSourceRoot, "preload.ts");
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
  // Determine execution directory:
  // - If running from super-ralph source, use super-ralph dir (has all deps including React)
  // - Otherwise use smithers dir or repo root
  let execCwd: string;
  if (runningFromSource) {
    execCwd = superRalphSourceRoot;
  } else {
    const smithersDir = dirname(dirname(smithersCliPath)); // Go up from src/cli to smithers root
    execCwd = existsSync(join(smithersDir, "node_modules")) ? smithersDir : repoRoot;
  }

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

  const proc = Bun.spawn(["bun", "--no-install", ...args], {
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
