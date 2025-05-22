/**
 * Search module for vector-based content retrieval
 * Handles query embedding, vector search, and result filtering
 */

import fs from "fs/promises";
import * as path from "path";

import { globalVectorStore, VECTOR_STORE_DIR } from "@src/vectorStore";
import { queryOllama } from "@src/ollama";
import {
  logProcessStart,
  logProcessEnd,
  logStatus,
  logProcessError,
} from "@lib/logging";

/**
 * Configuration options for content search
 */
export type SearchOptions = {
  limit?: number;
  minScore?: number;
  metadataFilter?: {
    filePath?: string;
    heading?: string;
    chunkIndex?: number;
    modifiedTime?: number;
    documentId?: string;
    [key: string]: any; // Allow for additional metadata fields from frontmatter
  };
  useKeywordSearch?: boolean;
  keywordWeight?: number;
  vectorWeight?: number;
};

const SEARCH_CONFIG: SearchOptions = {
  limit: 10,
  minScore: 0.6,
  useKeywordSearch: true,
  keywordWeight: 0.3,
  vectorWeight: 0.7,
};

/**
 * Performs a semantic search across vectorized content using both vector similarity and metadata filtering.
 *
 * This function:
 * 1. Generates embeddings for the search query using Ollama
 * 2. Performs vector similarity search against the vector store
 * 3. Applies metadata filters if specified
 * 4. Filters results by minimum similarity score
 * 5. Loads full text content for each result
 *
 * @param query - The search query string to find relevant content
 * @returns Promise resolving to an array of search results with scores
 *
 * @example
 * // Basic search
 * const results = await searchContent("What are the key features of TypeScript?");
 *
 * @example
 * // Search with metadata filtering
 * const results = await searchContent("TypeScript features", {
 *   metadataFilter: {
 *     filePath: "docs/typescript/",
 *     heading: "Features"
 *   }
 * });
 *
 * @example
 * // Search with custom scoring
 * const results = await searchContent("TypeScript features", {
 *   minScore: 0.7,
 *   limit: 5
 * });
 */
export async function searchContent(
  query: string
): Promise<Array<{ item: any; score: number }>> {
  logProcessStart("Content Search", { query, options: SEARCH_CONFIG });

  const {
    limit = 10,
    minScore = 0.5,
    metadataFilter,
    useKeywordSearch: _useKeywordSearch = true,
    keywordWeight: _keywordWeight = 0.3,
    vectorWeight: _vectorWeight = 0.7,
  } = SEARCH_CONFIG;

  try {
    logStatus("Checking vector store state");

    const indexExists = await globalVectorStore.isIndexCreated();
    logStatus("Vector store index status", { exists: indexExists });

    if (!indexExists) {
      logStatus("Creating vector store index");
      await globalVectorStore.createIndex();
    }

    logStatus("Generating query embedding");
    const queryEmbedding = await queryOllama(query);

    logStatus("Query embedding generated", {
      dimensions: queryEmbedding.length,
    });

    logStatus("Performing vector search");
    const vectorResults = await globalVectorStore.queryItems(
      queryEmbedding,
      query,
      limit * 2,
      undefined,
      true
    );

    logStatus("Initial search results", { count: vectorResults.length });

    let filteredResults = vectorResults;
    if (metadataFilter) {
      filteredResults = vectorResults.filter((result) => {
        return Object.entries(metadataFilter).every(([key, value]) => {
          if (Array.isArray(value)) {
            return value.includes(result.item.metadata[key]);
          }
          return result.item.metadata[key] === value;
        });
      });
      logStatus("Filtered results", {
        before: vectorResults.length,
        after: filteredResults.length,
        filters: metadataFilter,
      });
    }

    filteredResults = filteredResults.filter(
      (result) => result.score >= minScore
    );
    logStatus("Score filtered results", {
      before: filteredResults.length,
      after: filteredResults.filter((r) => r.score >= minScore).length,
      minScore,
    });

    const results = filteredResults.slice(0, limit);

    logStatus("Search results summary", {
      totalFound: results.length,
      topScore: results[0]?.score,
      lowestScore: results[results.length - 1]?.score,
    });

    for (const result of results) {
      if (
        result.item.metadata.documentId &&
        typeof result.item.metadata.documentId === "string"
      ) {
        try {
          const textContent = await fs.readFile(
            path.join(
              VECTOR_STORE_DIR,
              result.item.metadata.documentId + ".txt"
            ),
            "utf8"
          );
          result.item.metadata.text = textContent;
        } catch (error) {
          logProcessError("Text Content Loading", error as Error, {
            resultId: result.item.id,
            documentId: result.item.metadata.documentId,
            fullPath: path.join(
              VECTOR_STORE_DIR,
              result.item.metadata.documentId + ".txt"
            ),
          });
          result.item.metadata.text = "[Text unavailable]";
        }
      } else {
        logStatus("Missing document ID", { resultId: result.item.id });
        result.item.metadata.text = "[Text unavailable]";
      }
    }

    logProcessEnd("Content Search", {
      query,
      resultsFound: results.length,
      options: SEARCH_CONFIG,
    });

    return results;
  } catch (error) {
    logProcessError("Content Search", error as Error, {
      query,
      options: SEARCH_CONFIG,
    });
    if (
      error instanceof Error &&
      error.message.includes("document collection is too small")
    ) {
      logStatus("Search failed", {
        reason: "Not enough documents in the index for search",
        suggestion: "Please add more documents first",
      });
      return [];
    }
    throw error;
  }
}
