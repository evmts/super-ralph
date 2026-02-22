import React from "react";
import { Task } from "smithers-orchestrator";
import type { ClarificationSession } from "../cli/clarifications";
import { z } from "zod";

const focusSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export const interpretConfigOutputSchema = z.object({
  projectName: z.string().min(1),
  projectId: z.string().min(1),
  focuses: z.array(focusSchema).min(1).max(12),
  specsPath: z.string().min(1),
  referenceFiles: z.array(z.string()),
  buildCmds: z.record(z.string(), z.string()),
  testCmds: z.record(z.string(), z.string()),
  preLandChecks: z.array(z.string()),
  postLandChecks: z.array(z.string()),
  codeStyle: z.string().min(1),
  reviewChecklist: z.array(z.string()).min(1),
  maxConcurrency: z.number().int().min(1).max(64),
  reasoning: z.string().optional(),
});

export type InterpretConfigOutput = z.infer<typeof interpretConfigOutputSchema>;

export type InterpretConfigProps = {
  prompt: string;
  clarificationSession: ClarificationSession | null;
  repoRoot: string;
  fallbackConfig: InterpretConfigOutput;
  packageScripts: Record<string, string>;
  detectedAgents: {
    claude: boolean;
    codex: boolean;
    gh: boolean;
  };
  agent: any | any[];
};

/**
 * InterpretConfig Smithers Component
 *
 * Converts user prompt + clarification answers into SuperRalph configuration.
 * This is a simple wrapper around a Generate task with structured output.
 */
export function InterpretConfig({
  prompt,
  clarificationSession,
  repoRoot,
  fallbackConfig,
  packageScripts,
  detectedAgents,
  agent,
}: InterpretConfigProps) {
  const scriptsBlock = Object.entries(packageScripts)
    .map(([name, cmd]) => `- ${name}: ${cmd}`)
    .join("\n");

  const agentBlock = [
    detectedAgents.claude ? "- claude CLI available" : "- claude CLI unavailable",
    detectedAgents.codex ? "- codex CLI available" : "- codex CLI unavailable",
  ].join("\n");

  const clarificationBlock = clarificationSession
    ? [
        "",
        "User Clarifications (CRITICAL - use these to guide all configuration decisions):",
        "The user has answered detailed questions about their workflow preferences.",
        "You MUST incorporate these answers into the configuration.",
        "",
        clarificationSession.summary,
        "",
      ].join("\n")
    : "";

  const interpretPrompt = [
    "You are a workflow-config assistant for super-ralph.",
    "Return ONLY JSON. No markdown, no code fences, no commentary.",
    "",
    "Goal:",
    "Convert the user request into practical SuperRalph configuration fields.",
    clarificationSession
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
    clarificationSession
      ? "- CRITICAL: Interpret and apply the user's clarification answers to tailor the config."
      : "",
    "",
    `Repo root: ${repoRoot}`,
    "",
    "Detected CLIs:",
    agentBlock,
    "",
    "Existing package scripts:",
    scriptsBlock || "(none)",
    clarificationBlock,
    "Fallback config if unsure:",
    JSON.stringify(fallbackConfig, null, 2),
    "",
    "User request:",
    prompt,
  ].join("\n");

  return (
    <Task
      id="interpret-config"
      output={interpretConfigOutputSchema}
      agent={agent}
    >
      {interpretPrompt}
    </Task>
  );
}
