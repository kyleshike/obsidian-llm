/**
 * Ollama API integration module
 * Handles model initialization, embeddings, and streaming responses
 */

import {
  logProcessError,
  logStatus,
  logProcessStart,
  logProcessEnd,
} from "@lib/logging";
import { retryWithBackoff } from "@lib/util";

export const API_CONFIG = {
  baseUrl: "http://localhost:11434",
  queryModel: "mistral:latest",
  embeddingModel: "nomic-embed-text:latest",
  fallbackModels: [],
  healthCheckInterval: 30 * 1000,
  timeout: 30000,
  vectorDimensions: 768,
  maxRetries: 3,
  retryDelay: 1000,
  maxModelFailures: 3,
} as const;

type OllamaEmbeddingResponse = {
  embedding: number[];
};

/**
 * Type guard for Ollama embedding response
 * @param data - Response data to validate
 * @returns True if data matches OllamaEmbeddingResponse structure
 */
export function isOllamaEmbeddingResponse(
  data: unknown
): data is OllamaEmbeddingResponse {
  return (
    typeof data === "object" &&
    data !== null &&
    "embedding" in data &&
    Array.isArray((data as OllamaEmbeddingResponse).embedding) &&
    (data as OllamaEmbeddingResponse).embedding.every(
      (item) => typeof item === "number"
    )
  );
}

/**
 * Streams response tokens from Ollama chat API
 * @param prompt - User prompt to send
 * @param onToken - Callback for each received token
 */
export async function streamFromOllama(
  prompt: string,
  onToken: (token: string) => void
) {
  logProcessStart("Stream from Ollama");
  try {
    const res = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mistral",
        messages: [{ role: "user", content: prompt }],
        stream: true,
      }),
    });

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
      logProcessError("Stream from Ollama", new Error("No reader available"));
      return;
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const content = JSON.parse(
        decoder
          .decode(value, { stream: true })
          .split("\n")
          .filter(Boolean)
          .pop() ?? ""
      );
      if (
        content &&
        content.message &&
        typeof content.message.content === "string"
      ) {
        onToken(content.message.content);
      }
    }
    logProcessEnd("Stream from Ollama");
  } catch (error) {
    logProcessError("Stream from Ollama", error as Error);
    throw error;
  }
}

/**
 * Queries Ollama API for text embeddings
 * @param query - Text to generate embeddings for
 * @returns Vector embedding array
 */
export async function queryOllama(query: string) {
  return await retryWithBackoff(async () => {
    const response = await fetch(`${API_CONFIG.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: API_CONFIG.embeddingModel,
        prompt: query,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama API request failed with status ${response.status}: ${await response.text()}`
      );
    }

    const data = await response.json();
    if (!isOllamaEmbeddingResponse(data)) {
      throw new Error("Invalid response format from Ollama API");
    }
    return data.embedding;
  });
}

/**
 * Initializes required Ollama models
 * Pulls models if not available locally
 */
export async function initializeModels(): Promise<void> {
  logStatus("Initializing models...");

  try {
    const response = await fetch(`${API_CONFIG.baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      models?: Array<{ name: string }>;
    };
    const availableModels = new Set(data.models?.map((m) => m.name) || []);

    for (const model of [API_CONFIG.queryModel, API_CONFIG.embeddingModel]) {
      if (!availableModels.has(model)) {
        logStatus(`Model ${model} not found, pulling...`);

        await retryWithBackoff(async () => {
          const pullResponse = await fetch(`${API_CONFIG.baseUrl}/api/pull`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: model }),
          });

          if (!pullResponse.ok) {
            const errorText = await pullResponse.text();
            throw new Error(
              `Failed to pull model: ${pullResponse.statusText} - ${errorText}`
            );
          }

          const statusResponse = await fetch(
            `${API_CONFIG.baseUrl}/api/show?name=${model}`
          );
          if (!statusResponse.ok) {
            throw new Error("Model pull succeeded but model is not ready");
          }
        });

        logStatus(`Successfully pulled model ${model}`);
      }
    }

    logStatus("Model initialization completed");
  } catch (error) {
    logProcessError("Error during model initialization:", error as Error);
    throw error;
  }
}
