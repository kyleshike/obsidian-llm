/**
 * Logging utility for application-wide logging
 * Supports multiple log levels with color coding
 * Controlled by DEBUG environment variable
 */

import chalk from "chalk";

const DEBUG = process.env.DEBUG === "true";

type LogLevel =
  | "info" // General information
  | "warn" // Warning messages
  | "error" // Error messages
  | "debug" // Debug information
  | "success" // Successful operations
  | "process" // Process lifecycle events
  | "status" // Status updates
  | "skipped" // Skipped operations
  | "retrying"; // Retry attempts

/**
 * Formats a log message with timestamp and optional context
 * @param message - The log message
 * @param context - Optional context object to include
 * @returns Formatted message string
 */
function formatMessage(message: string, context?: Record<string, any>): string {
  const timestamp = new Date().toISOString();
  const contextStr = context ? `\n${JSON.stringify(context, null, 2)}` : "";
  return `[${timestamp}] ${message}${contextStr}`;
}

/**
 * Applies color to a formatted message based on log level
 * @param level - The log level
 * @param formattedMessage - The formatted message to color
 * @returns Colored message string
 */
function getColoredMessage(level: LogLevel, formattedMessage: string): string {
  switch (level) {
    case "error":
      return chalk.red(formattedMessage);
    case "warn":
      return chalk.yellow(formattedMessage);
    case "debug":
      return chalk.gray(formattedMessage);
    case "success":
      return chalk.green(formattedMessage);
    case "process":
      return chalk.magenta(formattedMessage);
    case "status":
      return chalk.cyan(formattedMessage);
    case "skipped":
      return chalk.gray(formattedMessage);
    case "retrying":
      return chalk.magenta(formattedMessage);
    default:
      return chalk.blue(formattedMessage);
  }
}

/**
 * Core logging function that handles message formatting and output
 * @param level - The log level
 * @param message - The log message
 * @param context - Optional context object
 */
function log(
  level: LogLevel,
  message: string,
  context?: Record<string, any>
): void {
  if (!DEBUG && level !== "error") return;

  const formattedMessage = formatMessage(message, context);
  const coloredMessage = getColoredMessage(level, formattedMessage).split("\n");

  switch (level) {
    case "error":
      console.error(...coloredMessage);
      break;
    case "warn":
      console.warn(...coloredMessage);
      break;
    default:
      console.log(...coloredMessage);
  }
}

/**
 * Logs the start of a process
 * @param processName - Name of the process
 * @param context - Optional context object
 */
export function logProcessStart(
  processName: string,
  context?: Record<string, any>
): void {
  log("process", `Starting: ${processName}`, context);
}

/**
 * Logs the successful completion of a process
 * @param processName - Name of the process
 * @param context - Optional context object
 */
export function logProcessEnd(
  processName: string,
  context?: Record<string, any>
): void {
  log("success", `Completed: ${processName}`, context);
}

/**
 * Logs a process error with stack trace
 * @param processName - Name of the process
 * @param error - Error object
 * @param context - Optional context object
 */
export function logProcessError(
  processName: string,
  error: Error,
  context?: Record<string, any>
): void {
  log("error", `Failed: ${processName}`, {
    ...context,
    error: error.message,
    stack: error.stack,
  });
}

/**
 * Logs a skipped process
 * @param processName - Name of the process
 * @param context - Optional context object
 */
export function logProcessSkipped(
  processName: string,
  context?: Record<string, any>
): void {
  log("skipped", `Skipped: ${processName}`, context);
}

/**
 * Logs a process retry attempt
 * @param processName - Name of the process
 * @param attempt - Retry attempt number
 * @param context - Optional context object
 */
export function logProcessRetrying(
  processName: string,
  attempt: number,
  context?: Record<string, any>
): void {
  log("retrying", `Retrying: ${processName} (Attempt ${attempt})`, context);
}

export function logStatus(
  message: string,
  context?: Record<string, any>
): void {
  log("status", message, context);
}

export function logDebug(message: string, context?: Record<string, any>): void {
  log("debug", message, context);
}

export function logWarning(
  message: string,
  context?: Record<string, any>
): void {
  log("warn", message, context);
}

export function logInfo(message: string, context?: Record<string, any>): void {
  log("info", message, context);
}

export function logSuccess(
  message: string,
  context?: Record<string, any>
): void {
  log("success", message, context);
}
