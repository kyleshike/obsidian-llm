/**
 * Vector store management for document embeddings
 * Handles storage, optimization, backup, and cleanup of vector embeddings
 */

import { mkdir, writeFile, access, readdir, rm } from "fs/promises";
import { statSync } from "fs";
import { resolve, join, relative } from "path";
import { LocalIndex } from "vectra";

import { loadCache, type CacheEntry } from "@lib/cache";
import {
  logStatus,
  logProcessStart,
  logProcessError,
  logSuccess,
  logInfo,
  logDebug,
  logProcessEnd,
  logWarning,
} from "@lib/logging";

const VECTOR_STORE_CONFIG = {
  maxOrphanedAge: 1 * 24 * 60 * 60 * 1000, // 1 day in milliseconds
  optimizationThreshold: 100_000, // Number of operations before optimization
  backupInterval: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
  maxBackups: 7, // Keep last 7 backups
} as const;

export const VECTOR_STORE_DIR = resolve(process.cwd(), "db");
export const globalVectorStore = new LocalIndex(VECTOR_STORE_DIR);

const TEXT_FILES_DIR = join(VECTOR_STORE_DIR, "text_files");
const BACKUP_DIR = join(VECTOR_STORE_DIR, "backups");

let lastBackupTime = 0;

const OPERATION_RESET_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
let operationCount = 0;
setInterval(() => {
  operationCount = 0;
  logStatus("Reset operation count");
}, OPERATION_RESET_INTERVAL);

/**
 * Gets all vector IDs from the cache
 * @returns Set of vector IDs
 */
async function getAllVectorIds(): Promise<Set<string>> {
  const cache = await loadCache();
  const ids = new Set<string>();

  for (const entry of Object.values(cache)) {
    if (entry && typeof entry === "object" && "vectorIds" in entry) {
      const typedEntry = entry as CacheEntry;
      typedEntry.vectorIds.forEach((id: string) => ids.add(id));
    }
  }

  return ids;
}

let vectorStoreLock = false;
let vectorStoreLockTimeout: NodeJS.Timeout | null = null;

/**
 * Acquires a lock on the vector store
 * @param timeout Lock timeout in milliseconds
 * @returns Whether lock was acquired
 */
async function acquireLock(timeout: number = 5000): Promise<boolean> {
  const start = Date.now();
  while (vectorStoreLock) {
    if (Date.now() - start > timeout) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  vectorStoreLock = true;
  vectorStoreLockTimeout = setTimeout(() => {
    vectorStoreLock = false;
    logStatus("Vector store lock timeout reached, releasing lock");
  }, timeout);
  return true;
}

/**
 * Releases the vector store lock
 */
function releaseLock() {
  if (vectorStoreLockTimeout) {
    clearTimeout(vectorStoreLockTimeout);
    vectorStoreLockTimeout = null;
  }
  vectorStoreLock = false;
}

/**
 * Normalizes a file path for storage
 * @param path File path to normalize
 * @returns Normalized path
 */
function normalizePathForStorage(path: string): string {
  return path.replace("vault/", "").replace(/[\\/:]/g, "_");
}

type VectorMetadata = {
  filePath: string;
  heading: string;
  chunkIndex: number;
  text: string;
  modifiedTime?: number;
} & Record<string, any>;

/**
 * Removes orphaned vectors from the store
 */
async function cleanupOrphanedVectors(): Promise<void> {
  logProcessStart("Orphaned Vector Cleanup");

  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    const error = new Error(
      "Failed to acquire vector store lock within timeout"
    );
    logProcessError("Vector Store Lock", error);
    throw error;
  }

  try {
    const cacheIds = await getAllVectorIds();
    const allVectors = await globalVectorStore.listItems();
    const now = Date.now();
    let deletedCount = 0;
    let skippedCount = 0;

    logInfo("Starting orphaned vector cleanup", {
      totalVectors: allVectors.length,
      cachedIds: cacheIds.size,
    });

    for (const vector of allVectors) {
      if (cacheIds.has(vector.id)) {
        continue;
      }

      const filePath = vector.id.split("::")[0];

      try {
        await access(filePath ?? "");
        logDebug("Skipping vector - file exists but not in cache yet", {
          vectorId: vector.id,
        });
        skippedCount++;
        continue;
      } catch {
        const metadata = vector.metadata as VectorMetadata;
        const modifiedTime = metadata.modifiedTime ?? now;
        const vectorAge = now - modifiedTime;

        if (vectorAge < VECTOR_STORE_CONFIG.maxOrphanedAge) {
          logDebug("Skipping vector - orphaned but not old enough", {
            vectorId: vector.id,
            ageHours: Math.round(vectorAge / (1000 * 60 * 60)),
          });
          skippedCount++;
          continue;
        }

        logInfo("Removing orphaned vector", {
          vectorId: vector.id,
          ageHours: Math.round(vectorAge / (1000 * 60 * 60)),
        });
        await globalVectorStore.deleteItem(vector.id);
        deletedCount++;
      }
    }

    logProcessEnd("Orphaned Vector Cleanup", {
      deletedCount,
      skippedCount,
      totalProcessed: allVectors.length,
    });
  } catch (error) {
    logProcessError("Orphaned Vector Cleanup", error as Error);
    throw error;
  } finally {
    releaseLock();
  }
}

/**
 * Optimizes the vector store by rebuilding the index
 */
async function optimizeVectorStore(): Promise<void> {
  logProcessStart("Vector Store Optimization");

  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    const error = new Error(
      "Failed to acquire vector store lock within timeout"
    );
    logProcessError("Vector Store Lock", error);
    throw error;
  }

  try {
    logInfo("Starting vector store optimization");
    await globalVectorStore.beginUpdate();

    const allVectors = await globalVectorStore.listItems();
    logInfo("Rebuilding index", { totalVectors: allVectors.length });

    await globalVectorStore.deleteIndex();
    await globalVectorStore.createIndex();

    logStatus("Reinserting vectors", { count: allVectors.length });
    for (const [index, vector] of allVectors.entries()) {
      await globalVectorStore.insertItem({
        id: vector.id,
        vector: vector.vector,
        metadata: vector.metadata,
      });

      if (index % 100 === 0) {
        logStatus("Optimization Progress", {
          processed: index + 1,
          total: allVectors.length,
        });
      }
    }

    await globalVectorStore.endUpdate();
    operationCount = 0;
    logSuccess("Vector store optimization completed", {
      totalVectors: allVectors.length,
    });
  } catch (error) {
    logProcessError("Vector Store Optimization", error as Error);
    throw error;
  } finally {
    releaseLock();
  }
}

/**
 * Removes old backups exceeding the maximum limit
 */
async function cleanupBackups(): Promise<void> {
  logProcessStart("Backup Cleanup");

  try {
    const backups = await readdir(BACKUP_DIR);
    const validBackups = backups.filter((backup) =>
      backup.match(/^backup-\d{4}-\d{2}-\d{2}/)
    );

    logInfo("Found backups", {
      total: backups.length,
      valid: validBackups.length,
      maxToKeep: VECTOR_STORE_CONFIG.maxBackups,
    });

    if (validBackups.length > VECTOR_STORE_CONFIG.maxBackups) {
      const sortedBackups = validBackups
        .map((name) => ({
          name,
          time: statSync(join(BACKUP_DIR, name)).mtime.getTime(),
        }))
        .sort((a, b) => b.time - a.time);

      const backupsToDelete = sortedBackups.slice(
        VECTOR_STORE_CONFIG.maxBackups
      );

      logStatus("Deleting old backups", {
        count: backupsToDelete.length,
        keeping: VECTOR_STORE_CONFIG.maxBackups,
      });

      for (const backup of backupsToDelete) {
        try {
          await rm(join(BACKUP_DIR, backup.name), { recursive: true });
          logDebug("Deleted old backup", { name: backup.name });
        } catch (error) {
          logProcessError("Backup Deletion", error as Error, {
            backupName: backup.name,
          });
        }
      }
    }

    logProcessEnd("Backup Cleanup", {
      totalBackups: validBackups.length,
      deletedCount: Math.max(
        0,
        validBackups.length - VECTOR_STORE_CONFIG.maxBackups
      ),
    });
  } catch (error) {
    logProcessError("Backup Cleanup", error as Error);
    throw error;
  }
}

async function backupVectorStore(): Promise<void> {
  const now = Date.now();
  if (now - lastBackupTime < VECTOR_STORE_CONFIG.backupInterval) {
    logDebug("Skipping backup - too soon since last backup", {
      timeSinceLastBackup: now - lastBackupTime,
      backupInterval: VECTOR_STORE_CONFIG.backupInterval,
    });
    return;
  }

  logProcessStart("Vector Store Backup");

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(BACKUP_DIR, `backup-${timestamp}`);

    logInfo("Creating backup directory", { path: backupPath });
    await mkdir(backupPath, { recursive: true });

    logStatus("Backing up cache");
    const cache = await loadCache();
    await writeFile(
      join(backupPath, "cache.json"),
      JSON.stringify(cache, null, 2)
    );

    logStatus("Backing up vectors");
    const allVectors = await globalVectorStore.listItems();
    await writeFile(
      join(backupPath, "vectors.json"),
      JSON.stringify(allVectors, null, 2)
    );

    logInfo("Cleaning up old backups");
    await cleanupBackups();

    lastBackupTime = now;
    logSuccess("Vector store backup completed", {
      backupPath,
      cacheEntries: Object.keys(cache).length,
      vectorCount: allVectors.length,
    });
  } catch (error) {
    logProcessError("Vector Store Backup", error as Error);
    logWarning("Continuing without backup");
  }
}

export async function storeChunks(
  filePath: string,
  embeddedChunks: { embedding: number[]; text: string }[]
): Promise<string[]> {
  logProcessStart("Vector Store Update", {
    filePath,
    chunksToStore: embeddedChunks.length,
  });

  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    const error = new Error(
      "Failed to acquire vector store lock within timeout"
    );
    logProcessError("Vector Store Lock", error, { filePath });
    throw error;
  }

  try {
    await mkdir(VECTOR_STORE_DIR, { recursive: true });
    await mkdir(TEXT_FILES_DIR, { recursive: true });
    const generatedIds: string[] = [];

    if (!(await globalVectorStore.isIndexCreated())) {
      logInfo("Creating vector store index");
      try {
        await globalVectorStore.createIndex();
        logSuccess("Index created successfully");
      } catch (e: any) {
        logProcessError("Index Creation", e, { filePath });
        throw e;
      }
    }

    try {
      logStatus("Beginning vector store update");
      await globalVectorStore.beginUpdate();

      logStatus("Checking existing vectors", { filePath });
      const existingVectors = await globalVectorStore.listItems();
      const existingIds = new Set(
        existingVectors
          .filter((v) => v.id.startsWith(filePath))
          .map((v) => v.id)
      );

      for (const id of existingIds) {
        try {
          await globalVectorStore.deleteItem(id);
          logDebug("Deleted existing vector", { id });
        } catch (error) {
          logWarning("Failed to delete existing vector", { id, error });
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      logStatus("Adding vectors", { count: embeddedChunks.length });
      for (const [index, chunk] of embeddedChunks.entries()) {
        const relativePath = relative(process.cwd(), filePath);
        const chunkId = `${relativePath}::${index}`;
        try {
          const textContent = chunk.text || "";
          const sanitizedPath = normalizePathForStorage(chunkId);
          const textFilePath = join(TEXT_FILES_DIR, `${sanitizedPath}.txt`);
          await writeFile(textFilePath, textContent, "utf8");

          const vectorData = {
            id: chunkId,
            vector: chunk.embedding,
            metadata: {
              documentId: `text_files/${sanitizedPath}`,
            },
          };

          const existingVector = await globalVectorStore.getItem(chunkId);
          if (existingVector) {
            logDebug("Vector already exists, replacing", { chunkId });
            await globalVectorStore.deleteItem(chunkId);
            await globalVectorStore.insertItem(vectorData);
          } else {
            await globalVectorStore.insertItem(vectorData);
          }

          logDebug("Vector processed", { chunkId });
          generatedIds.push(chunkId);
          operationCount++;

          if (index % 10 === 0) {
            logStatus("Vector Processing Progress", {
              processed: index + 1,
              total: embeddedChunks.length,
            });
          }
        } catch (error) {
          logProcessError("Chunk Processing", error as Error, {
            filePath,
            chunkIndex: index,
          });
          throw error;
        }
      }
      logSuccess("Vectors stored successfully", { count: generatedIds.length });
    } finally {
      try {
        logStatus("Ending vector store update");
        await globalVectorStore.endUpdate();
        logSuccess("Vector store update completed");
      } catch (e) {
        logProcessError("Vector Store Update End", e as Error, { filePath });
        throw e;
      }
    }

    if (operationCount >= VECTOR_STORE_CONFIG.optimizationThreshold) {
      logInfo("Optimization threshold reached", { operationCount });
      await optimizeVectorStore();
    }

    try {
      await backupVectorStore();
    } catch (error) {
      logProcessError("Vector Store Backup", error as Error, { filePath });
    }

    await cleanupOrphanedVectors();

    logProcessEnd("Vector Store Update", {
      filePath,
      vectorsStored: generatedIds.length,
    });

    return generatedIds;
  } finally {
    releaseLock();
  }
}
