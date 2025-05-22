/**
 * Cache management for vector store
 * Handles saving and loading cache with atomic writes and error recovery
 */

import { logStatus, logProcessError } from "@lib/logging";
import { mkdir } from "fs/promises";
import { readFile, rename, unlink, writeFile } from "fs/promises";
import { resolve } from "path";

const VECTOR_STORE_DIR = resolve(process.cwd(), "db");
const CACHE_FILE_PATH = ".cache.json";

export type CacheEntry = {
  contentHash: string;
  vectorIds: string[];
  modifiedTime: number;
};

export type Cache = Record<string, CacheEntry>;

let cacheLock = false;

/**
 * Saves cache to disk with atomic write and backup
 * @param cache - Cache object to save
 * @throws Error if write fails or verification fails
 */
export async function saveCache(cache: Cache) {
  while (cacheLock) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  cacheLock = true;
  try {
    logStatus("Saving cache...");

    await mkdir(VECTOR_STORE_DIR, { recursive: true });

    const tempPath = `${CACHE_FILE_PATH}.tmp`;
    const backupPath = `${CACHE_FILE_PATH}.bak`;
    const cacheData = JSON.stringify(cache, null, 2);

    try {
      await writeFile(tempPath, cacheData, "utf8");

      const writtenData = await readFile(tempPath, "utf8");
      if (writtenData !== cacheData) {
        throw new Error(
          "Cache verification failed: written data doesn't match"
        );
      }

      try {
        await rename(CACHE_FILE_PATH, backupPath);
      } catch {}

      await rename(tempPath, CACHE_FILE_PATH);
      await unlink(backupPath).catch(() => {});

      logStatus("Cache saved successfully");
    } catch (error) {
      try {
        await rename(backupPath, CACHE_FILE_PATH);
      } catch {}
      throw error;
    }
  } catch (error) {
    logProcessError("Error saving cache:", error as Error);
    throw error;
  } finally {
    cacheLock = false;
  }
}

/**
 * Loads cache from disk
 * @returns Cache object or empty object if no cache exists
 * @throws Error if cache file is corrupted
 */
export async function loadCache(): Promise<Cache> {
  while (cacheLock) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  cacheLock = true;
  try {
    logStatus("Loading cache...");

    await mkdir(VECTOR_STORE_DIR, { recursive: true });

    try {
      const data = await readFile(CACHE_FILE_PATH, "utf8");
      const cache = JSON.parse(data) as Cache;
      logStatus(
        `Cache loaded successfully with ${Object.keys(cache).length} entries`
      );
      return cache;
    } catch (error: any) {
      if (error.code === "ENOENT") {
        logStatus("No cache file found, starting fresh");
        return {};
      }
      throw error;
    }
  } catch (error) {
    logProcessError("Error loading cache:", error as Error);
    throw error;
  } finally {
    cacheLock = false;
  }
}
