#!/usr/bin/env bun
/**
 * Interactive Questions UI - External Process
 *
 * This script is launched by the ClarifyingQuestions Smithers component
 * to collect user answers via a keyboard-navigable interface.
 *
 * Usage:
 *   bun interactive-questions.ts <questions-file.json> <answers-output.json>
 *
 * Input format (questions-file.json):
 *   { "questions": [ { "question": "...", "choices": [...] } ] }
 *
 * Output format (answers-output.json):
 *   { "answers": [ { "question": "...", "answer": "...", "isCustom": false } ] }
 */

import { readFile, writeFile } from "node:fs/promises";
import type { ClarificationQuestion, ClarificationAnswer } from "./clarifications.ts";

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

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 2) {
    console.error("Usage: bun interactive-questions.ts <questions-file.json> <answers-output.json>");
    process.exit(1);
  }

  const [questionsPath, answersPath] = args;

  // Read questions
  const questionsJson = await readFile(questionsPath, "utf8");
  const questionsData = JSON.parse(questionsJson);
  const questions: ClarificationQuestion[] = questionsData.questions;

  if (!Array.isArray(questions) || questions.length === 0) {
    console.error("Error: Questions file must contain a non-empty 'questions' array");
    process.exit(1);
  }

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

  // Write answers to output file
  await writeFile(answersPath, JSON.stringify({ answers }, null, 2), "utf8");

  console.log(`\nAnswers saved to: ${answersPath}\n`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
