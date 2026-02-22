import React from "react";
import type { SmithersCtx } from "smithers-orchestrator";
import { Task, Sequence } from "smithers-orchestrator";
import type { ClarificationQuestion, ClarificationAnswer, ClarificationSession } from "../cli/clarifications";
import { z } from "zod";

const generateQuestionsOutputSchema = z.object({
  questions: z.array(z.object({
    question: z.string(),
    choices: z.array(z.object({
      label: z.string(),
      description: z.string(),
      value: z.string(),
    })),
  })),
});

export const clarifyingQuestionsOutputSchema = z.object({
  questions: z.array(z.object({
    question: z.string(),
    choices: z.array(z.object({
      label: z.string(),
      description: z.string(),
      value: z.string(),
    })),
  })),
  answers: z.array(z.object({
    question: z.string(),
    answer: z.string(),
    isCustom: z.boolean(),
  })),
  session: z.object({
    answers: z.array(z.object({
      question: z.string(),
      answer: z.string(),
      isCustom: z.boolean(),
    })),
    summary: z.string(),
  }),
});

export type ClarifyingQuestionsOutput = z.infer<typeof clarifyingQuestionsOutputSchema>;

export type ClarifyingQuestionsProps = {
  ctx: SmithersCtx<any>;
  outputs: any;
  prompt: string;
  repoRoot: string;
  packageScripts: Record<string, string>;
  agent: any | any[];
  // Optional: pre-generated questions to skip AI generation phase
  preGeneratedQuestions?: ClarificationQuestion[];
};

/**
 * ClarifyingQuestions Smithers Component
 *
 * This component generates contextual clarifying questions using AI,
 * then collects user answers via an external interactive UI process.
 *
 * Workflow:
 * 1. Generate questions using AI (Task with agent)
 * 2. Write questions to a temporary file
 * 3. Launch external keyboard UI process (blocks until user completes)
 * 4. Read answers from output file
 * 5. Return structured session output
 *
 * Note: This uses external process coordination instead of Smithers lifecycle
 * callbacks, which allows it to work with the existing Smithers engine.
 */
export function ClarifyingQuestions({
  ctx,
  outputs,
  prompt,
  repoRoot,
  packageScripts,
  agent,
  preGeneratedQuestions,
}: ClarifyingQuestionsProps) {
  const scriptsBlock = Object.entries(packageScripts)
    .map(([name, cmd]) => `- ${name}: ${cmd}`)
    .join("\n");

  const questionGenerationPrompt = `You are a workflow configuration assistant for Super Ralph.

Your task: Generate 10-15 clarifying questions to help customize a development workflow.

Context:
- User's request: ${prompt}
- Repository: ${repoRoot}
- Available scripts: ${scriptsBlock || "(none)"}

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
- Make each question relevant to "${prompt}"

Return valid JSON only, no markdown, no explanations.`;

  // Implementation note:
  // We use a compute function to coordinate the interactive workflow.
  // This is a pragmatic approach that works with existing Smithers without
  // requiring lifecycle callbacks.
  return (
    <Sequence>
      {/* Step 1: Generate questions (if not pre-provided) */}
      {!preGeneratedQuestions && (
        <Task
          id="generate-questions"
          output={generateQuestionsOutputSchema}
          agent={agent}
        >
          {questionGenerationPrompt}
        </Task>
      )}

      {/* Step 2: Collect answers via external UI and assemble session */}
      <Task
        id="collect-clarification-answers"
        output={clarifyingQuestionsOutputSchema}
      >
        {async () => {
          // Get questions either from previous step or pre-provided
          let questions: ClarificationQuestion[];
          if (preGeneratedQuestions) {
            questions = preGeneratedQuestions;
          } else {
            const generated = (ctx as any).outputMaybe("generate-questions");
            if (!generated?.questions || !Array.isArray(generated.questions)) {
              throw new Error("Failed to generate clarifying questions");
            }
            questions = generated.questions;
          }

          // Write questions to temp file for external UI
          const { writeFile, readFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const { randomUUID } = await import("node:crypto");

          const sessionId = randomUUID();
          const tempDir = join(repoRoot, ".super-ralph", "temp");
          await import("node:fs/promises").then(fs => fs.mkdir(tempDir, { recursive: true }));

          const questionsPath = join(tempDir, `questions-${sessionId}.json`);
          const answersPath = join(tempDir, `answers-${sessionId}.json`);

          await writeFile(questionsPath, JSON.stringify({ questions }, null, 2));

          // Launch external UI process to collect answers
          // This blocks until the user completes all questions
          const { spawn } = await import("node:child_process");

          await new Promise<void>((resolve, reject) => {
            // The external UI script reads questions and writes answers
            const uiProcess = spawn("bun", [
              join(import.meta.dir, "../cli/interactive-questions.ts"),
              questionsPath,
              answersPath,
            ], {
              stdio: "inherit",
              cwd: repoRoot,
            });

            uiProcess.on("close", (code) => {
              if (code === 0) {
                resolve();
              } else {
                reject(new Error(`Interactive UI exited with code ${code}`));
              }
            });

            uiProcess.on("error", reject);
          });

          // Read collected answers
          const answersJson = await readFile(answersPath, "utf8");
          const answersData = JSON.parse(answersJson);

          const answers: ClarificationAnswer[] = answersData.answers;

          // Build summary
          const summary = answers
            .map((a, i) => `${i + 1}. ${a.question}\n   → ${a.answer}`)
            .join("\n\n");

          const session: ClarificationSession = {
            answers,
            summary,
          };

          // Cleanup temp files
          try {
            await import("node:fs/promises").then(fs => Promise.all([
              fs.unlink(questionsPath),
              fs.unlink(answersPath),
            ]));
          } catch {
            // Ignore cleanup errors
          }

          return {
            questions,
            answers,
            session,
          };
        }}
      </Task>
    </Sequence>
  );
}
