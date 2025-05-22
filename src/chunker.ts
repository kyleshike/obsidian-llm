/**
 * File chunking and embedding utilities
 * Splits markdown files into chunks based on headings
 * Generates vector embeddings for text chunks using Ollama API
 */

import {
  logProcessStart,
  logProcessEnd,
  logProcessError,
  logDebug,
  logProcessRetrying,
  logWarning,
  logInfo,
  logStatus,
} from "@lib/logging";
import { API_CONFIG, isOllamaEmbeddingResponse } from "@src/ollama";
import { rateLimiter } from "@lib/rateLimiter";
import { retryWithBackoff } from "@lib/util";

/**
 * Splits markdown file content into chunks based on heading hierarchy
 * @param filePath - Path to the markdown file
 * @param fileContent - Content of the markdown file
 * @returns Array of text chunks with heading context
 */
export async function chunkFile(
  filePath: string,
  fileContent: string
): Promise<string[]> {
  logProcessStart("File Chunking", { filePath });

  const fileParts = filePath
    .split("vault/")
    .pop()
    ?.split("/")
    .map((part) => part.replace(".md", ""))
    .join(" > ");

  console.log({ fileParts });

  try {
    const lines = fileContent.split("\n");
    return lines
      .reduce<{ headingStack: string[]; chunks: string[] }>(
        (acc, line) => {
          if (acc.chunks.length === 0) {
            acc.chunks.push("");
          }

          if (line.startsWith("#")) {
            const headingLevel = line.match(/^#+/)?.[0].length ?? 0;
            let lastHeadingLevel =
              acc.headingStack[acc.headingStack.length - 1]?.match(/^#+/)?.[0]
                .length ?? 0;

            while (lastHeadingLevel >= headingLevel) {
              acc.headingStack.pop();
              lastHeadingLevel =
                acc.headingStack[acc.headingStack.length - 1]?.match(/^#+/)?.[0]
                  .length ?? -Infinity;
            }

            acc.headingStack.push(line);
            acc.chunks.push(fileParts + "\n" + acc.headingStack.join("\n"));
          } else {
            acc.chunks[acc.chunks.length - 1] += `\n${line}`;
          }
          return acc;
        },
        { headingStack: [], chunks: [] }
      )
      .chunks.filter(Boolean);
  } catch (error) {
    logProcessError("File Chunking", error as Error, { filePath });
    throw error;
  }
}

/**
 * Validates vector dimensions against expected size
 * @param vector - Vector to validate
 * @returns True if dimensions match expected size
 */
function validateVectorDimensions(vector: number[]): boolean {
  const expectedDimension = API_CONFIG.vectorDimensions;
  if (vector.length !== expectedDimension) {
    logStatus(
      `Vector dimension mismatch: expected ${expectedDimension}, got ${vector.length}`
    );
    return false;
  }
  return true;
}

/**
 * Generates vector embeddings for text chunks using Ollama API
 * @param chunks - Array of text chunks to embed
 * @returns Array of embeddings with original text
 */
export async function embedChunks(chunks: string[]) {
  if (chunks.length === 0) {
    logInfo("No chunks to embed");
    return [];
  }

  logProcessStart("Chunk Embedding", { totalChunks: chunks.length });
  const results: {
    embedding: number[];
    text: string;
  }[] = [];

  const failedChunks: { chunk: (typeof chunks)[0]; error: Error }[] = [];

  for (const [index, chunk] of chunks.entries()) {
    let success = false;
    let lastError: Error | null = null;

    logStatus(`Processing chunk ${index + 1}/${chunks.length}`, {
      chunkIndex: index,
      totalChunks: chunks.length,
    });

    for (
      let attempts = 0;
      attempts <= API_CONFIG.fallbackModels.length;
      attempts++
    ) {
      try {
        await rateLimiter.waitForSlot();
        const embedding = await retryWithBackoff(async () => {
          logDebug("Generating embedding", {
            chunkIndex: index,
            attempt: attempts + 1,
          });

          const response = await fetch(`${API_CONFIG.baseUrl}/api/embeddings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "nomic-embed-text:latest",
              prompt: chunk,
            }),
            signal: AbortSignal.timeout(API_CONFIG.timeout),
          });

          if (!response.ok) {
            throw new Error(
              `Ollama API request failed with status ${response.status}: ${await response.text()}`
            );
          }

          const data = await response.json();

          if (!isOllamaEmbeddingResponse(data)) {
            throw new Error("Invalid embedding format received from Ollama");
          }

          console.log({ data, chunk });

          if (!validateVectorDimensions(data.embedding)) {
            throw new Error("Vector dimension mismatch");
          }

          return data.embedding;
        });

        results.push({
          embedding,
          text: chunk,
        });

        success = true;
        logDebug("Successfully embedded chunk", {
          chunkIndex: index,
          vectorDimensions: embedding.length,
        });
        break;
      } catch (error) {
        lastError = error as Error;
        logProcessError("Chunk Embedding", error as Error, {
          chunkIndex: index,
          attempt: attempts + 1,
        });

        if (attempts < API_CONFIG.fallbackModels.length) {
          logProcessRetrying("Chunk Embedding", attempts + 1, {
            chunkIndex: index,
            error: lastError.message,
          });
        }
      }
    }

    if (!success) {
      logWarning("Failed to embed chunk after all attempts", {
        chunkIndex: index,
        error: lastError?.message,
      });
      failedChunks.push({ chunk, error: lastError! });
    }
  }

  if (failedChunks.length > 0) {
    logWarning("Retrying failed chunks", {
      failedCount: failedChunks.length,
      totalChunks: chunks.length,
    });

    const retryResults = await embedChunks(
      failedChunks.map(({ chunk }) => chunk)
    );

    results.push(...retryResults);
  }

  logProcessEnd("Chunk Embedding", {
    totalChunks: chunks.length,
    successfulChunks: results.length,
    failedChunks: failedChunks.length,
  });

  return results;
}
