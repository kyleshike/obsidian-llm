/**
 * File processing module for vault watching and content management
 * Handles file events, queueing, caching, and vector storage
 */

import crypto from "crypto";
import { watch } from "chokidar";
import { stat, readFile, writeFile, readdir } from "fs/promises";
import { join, normalize, resolve } from "path";

import { loadCache, saveCache, type Cache } from "@lib/cache";
import {
  logProcessStart,
  logProcessError,
  logProcessSkipped,
  logInfo,
  logStatus,
  logProcessEnd,
} from "@lib/logging";
import { chunkFile, embedChunks } from "@src/chunker";
import { globalVectorStore, storeChunks } from "@src/vectorStore";

const QUEUE_FILE = ".queue.json";
const fileQueue: { event: string; filePath: string }[] = [];

let isProcessingFile = false;

/**
 * Saves current file queue to disk
 */
async function saveQueue() {
  try {
    await writeFile(QUEUE_FILE, JSON.stringify(fileQueue));
  } catch (error) {
    logProcessError("Failed to save queue:", error as Error);
  }
}

/**
 * Loads file queue from disk
 * @returns Array of queued file events
 */
async function loadQueue() {
  try {
    const data = await readFile(QUEUE_FILE, "utf8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/**
 * Recovers and processes queued file operations after restart
 */
export async function recoverVaultWatchQueue() {
  try {
    const savedQueue = await loadQueue();
    if (savedQueue.length > 0) {
      logStatus(`Recovering ${savedQueue.length} queued operations...`);
      fileQueue.push(...savedQueue);
      const nextFile = fileQueue.shift();
      if (nextFile) {
        await saveQueue();
        handleFileEvent(nextFile.event, nextFile.filePath);
      }
    }
  } catch (error) {
    logProcessError("Failed to recover queue:", error as Error);
  }
}

/**
 * Processes file events with queue management
 * @param event - File event type (add/change/unlink)
 * @param filePath - Path to affected file
 */
async function handleFileEvent(event: string, filePath: string) {
  if (isProcessingFile) {
    logStatus(
      `Queueing ${event} for ${filePath} (1 operation already in progress). Queue size: ${fileQueue.length + 1}`
    );
    fileQueue.push({ event, filePath });
    await saveQueue();
    return;
  }

  isProcessingFile = true;
  try {
    logStatus(`Processing ${event} for ${filePath}`);
    switch (event) {
      case "add":
        await processFile(filePath);
        break;
      case "change":
        await deleteFile(filePath);
        await processFile(filePath);
        break;
      case "unlink":
        await deleteFile(filePath);
        break;
    }
    logStatus(`Finished processing ${event} for ${filePath}`);
  } catch (error: any) {
    logProcessError(
      `Error processing ${event} for ${filePath}: ${error.message}`,
      error as Error
    );
  } finally {
    isProcessingFile = false;
    if (fileQueue.length > 0) {
      const nextFile = fileQueue.shift();
      if (nextFile) {
        logStatus(
          `Dequeuing ${nextFile.event} for ${nextFile.filePath} to process next. Remaining in queue: ${fileQueue.length}`
        );
        await saveQueue();
        setImmediate(() => handleFileEvent(nextFile.event, nextFile.filePath));
      }
    } else {
      logStatus("File processing queue is empty.");
    }
  }
}

/**
 * Processes file content and updates cache
 * @param filePath - Path to file to process
 */
async function processFile(filePath: string) {
  logProcessStart("File Processing", { filePath });

  try {
    const stats = await stat(filePath);
    const modifiedTime = stats.mtime.getTime();

    let cache: Cache;
    try {
      cache = await loadCache();
    } catch (error) {
      logProcessError("Cache Loading", error as Error, { filePath });
      cache = {};
    }

    const cachedFile = cache[filePath];
    const fileContent = await readFile(filePath, "utf8");
    const contentHash = crypto
      .createHash("sha256")
      .update(fileContent)
      .digest("hex");

    if (
      cachedFile &&
      cachedFile.modifiedTime === modifiedTime &&
      cachedFile.contentHash === contentHash
    ) {
      logProcessSkipped("File Processing", {
        filePath,
        reason: "content and modification time match",
      });
      return;
    }

    if (cachedFile && cachedFile.contentHash === contentHash) {
      logInfo("File content unchanged", {
        filePath,
        action: "updating modification time only",
      });
      cache[filePath] = {
        ...cachedFile,
        modifiedTime,
      };
      try {
        await saveCache(cache);
      } catch (error) {
        logProcessError("Cache Update", error as Error, { filePath });
      }
      return;
    }

    logStatus("Processing file content", { filePath });
    const chunks = await chunkFile(filePath, fileContent);
    const embeddings = await embedChunks(chunks);
    const vectorIds = await storeChunks(filePath, embeddings);

    cache[filePath] = {
      contentHash,
      vectorIds,
      modifiedTime,
    };

    try {
      await saveCache(cache);
    } catch (error) {
      logProcessError("Cache Save", error as Error, { filePath });
    }

    logProcessEnd("File Processing", {
      filePath,
      chunksProcessed: chunks.length,
      vectorsStored: vectorIds.length,
    });
  } catch (error) {
    logProcessError("File Processing", error as Error, { filePath });
    throw error;
  }
}

/**
 * Removes file from cache and vector store
 * @param filePath - Path to file to delete
 */
async function deleteFile(filePath: string) {
  logStatus("Deleting files", { filePath });
  const cache = await loadCache();
  const updated = Object.fromEntries(
    Object.entries(cache).filter(([chunkId]) => !chunkId.startsWith(filePath))
  );
  const deleted = Object.fromEntries(
    Object.entries(cache).filter(([chunkId]) => chunkId.startsWith(filePath))
  );

  for (const [chunkId] of Object.entries(deleted)) {
    await globalVectorStore.deleteItem(chunkId);
  }

  await saveCache(updated);
}

/**
 * Initializes file system watcher for vault directory
 * Sets up event handlers and processes existing files
 */
export function initializeVaultWatch() {
  const vaultPath = "./vault";
  const absoluteVaultPath = resolve(process.cwd(), vaultPath);
  const watcher = watch(absoluteVaultPath, {
    ignored: [
      "**/.DS_Store",
      "**/.git/**",
      "**/.obsidian/**",
      "**/node_modules/**",
    ],
    persistent: true,
    ignoreInitial: false,
  });

  watcher.on("all", (event, filePath) => {
    const isMarkdown = filePath.endsWith(".md");
    const isValidEvent = ["add", "change", "unlink"].includes(event);

    if (!isMarkdown || !isValidEvent) return;

    const normalizedPath = normalize(filePath);
    handleFileEvent(event, normalizedPath);
  });

  watcher.on("error", (error) => {
    logProcessError("Watcher", error as Error);
  });

  const processAllFiles = async () => {
    logStatus("Processing all markdown files on startup...");
    const files = await readdir(vaultPath);
    for (const file of files) {
      const filePath = join(vaultPath, file);
      const stats = await stat(filePath);
      if (stats.isDirectory()) {
        const subFiles = await readdir(filePath);
        for (const subFile of subFiles) {
          if (subFile.endsWith(".md")) {
            const subFilePath = join(filePath, subFile);
            handleFileEvent("add", subFilePath);
          }
        }
      } else if (file.endsWith(".md")) {
        handleFileEvent("add", filePath);
      }
    }
  };

  processAllFiles().catch((error) => {
    logProcessError("Error processing files on startup:", error as Error);
  });
}
