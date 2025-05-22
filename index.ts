/**
 * CLI interface for D&D campaign assistant
 * Handles user input, content search, and AI response streaming
 */

import readline from "readline";
import chalk from "chalk";

import { logProcessError, logInfo } from "@lib/logging";
import { streamFromOllama, initializeModels } from "@src/ollama";
import {
  recoverVaultWatchQueue,
  initializeVaultWatch,
} from "@src/fileProcessing";
import { searchContent } from "@src/search";
import { buildPrompt } from "./prompt";

/**
 * Initializes and manages the CLI interface
 * Handles user input, content search, and response streaming
 */
async function startCLI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.green("> "),
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    const results = await searchContent(input);

    const retrievedContent = results
      .map(
        (result) =>
          `Source: ${result.item.metadata.filePath}\n` +
          `Score: ${result.score.toFixed(2)}\n` +
          `Content: ${result.item.metadata.text}\n`
      )
      .join("\n");

    let buffer = "";
    const prompt = buildPrompt(input, retrievedContent);

    prompt
      .split("\n")
      .filter(Boolean)
      .map((el) => logInfo(el));

    await streamFromOllama(prompt, (token) => {
      if (token === undefined || token === null) return;
      buffer += token;
      process.stdout.write(token);
    });

    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

/**
 * Main entry point
 * Initializes models, recovers vault watch queue, and starts CLI
 */
async function main() {
  try {
    await initializeModels();
    await recoverVaultWatchQueue();

    initializeVaultWatch();
    startCLI();
  } catch (error) {
    logProcessError("Failed to initialize system:", error as Error);
    process.exit(1);
  }
}

main();
