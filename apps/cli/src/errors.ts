import pc from "picocolors";
import {
  ExpectedError,
  ServerConnectionError,
} from "@odyshell/sdk";

export { ExpectedError, ServerConnectionError };

export type ErrorReport = {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  status?: number;
  errno?: string | number;
  syscall?: string;
  address?: string;
  port?: number;
  details?: unknown;
  cause?: ErrorReport;
};

export function errorReport(
  error: unknown,
  options: { includeStack?: boolean } = {},
): ErrorReport {
  return report(error, new Set(), 0, options.includeStack ?? true);
}

export function printCliError(error: unknown, json: boolean): void {
  const value = errorReport(error, { includeStack: !isExpected(error) });
  const hint = connectionHint(value);
  if (json) {
    process.stderr.write(
      `${JSON.stringify(
        { ok: false, error: { ...value, ...(hint ? { hint } : {}) } },
        null,
        2,
      )}\n`,
    );
    return;
  }

  console.error(pc.red(`${value.name}: ${value.message}`));
  printMetadata(value);
  if (value.stack) {
    console.error(pc.dim("Stack trace:"));
    console.error(value.stack);
  }

  let cause = value.cause;
  while (cause) {
    console.error(pc.yellow("\nCaused by:"));
    console.error(`${cause.name}: ${cause.message}`);
    printMetadata(cause);
    if (cause.stack) console.error(cause.stack);
    cause = cause.cause;
  }

  if (hint) console.error(pc.cyan(`\nHint: ${hint}`));
}

function report(
  error: unknown,
  seen: Set<object>,
  depth: number,
  includeStack: boolean,
): ErrorReport {
  if (depth >= 8) return { name: "Error", message: "Cause chain exceeded 8 levels" };
  if (!(error instanceof Error)) {
    return { name: "Error", message: typeof error === "string" ? error : String(error) };
  }
  if (seen.has(error)) return { name: error.name, message: "Circular error cause" };
  seen.add(error);

  const record = error as Error & {
    code?: unknown;
    status?: unknown;
    errno?: unknown;
    syscall?: unknown;
    address?: unknown;
    port?: unknown;
    details?: unknown;
    cause?: unknown;
  };
  return {
    name: error.name || "Error",
    message: error.message,
    ...(includeStack && error.stack ? { stack: error.stack } : {}),
    ...(isStringOrNumber(record.code) ? { code: record.code } : {}),
    ...(typeof record.status === "number" ? { status: record.status } : {}),
    ...(isStringOrNumber(record.errno) ? { errno: record.errno } : {}),
    ...(typeof record.syscall === "string" ? { syscall: record.syscall } : {}),
    ...(typeof record.address === "string" ? { address: record.address } : {}),
    ...(typeof record.port === "number" ? { port: record.port } : {}),
    ...(record.details === undefined ? {} : { details: record.details }),
    ...(record.cause === undefined
      ? {}
      : { cause: report(record.cause, seen, depth + 1, includeStack) }),
  };
}

function printMetadata(value: ErrorReport): void {
  const entries = [
    ["status", value.status],
    ["code", value.code],
    ["errno", value.errno],
    ["syscall", value.syscall],
    ["address", value.address],
    ["port", value.port],
  ].filter((entry): entry is [string, string | number] => entry[1] !== undefined);
  for (const [key, item] of entries) console.error(`  ${key}: ${item}`);
  if (value.details !== undefined) {
    console.error("  details:");
    console.error(JSON.stringify(value.details, null, 2));
  }
}

function connectionHint(value: ErrorReport): string | undefined {
  const codes = new Set<string>();
  let current: ErrorReport | undefined = value;
  while (current) {
    if (current.code !== undefined) codes.add(String(current.code));
    if (current.errno !== undefined) codes.add(String(current.errno));
    current = current.cause;
  }
  if (codes.has("ECONNREFUSED")) {
    return "The address was reached, but no server accepted the connection. Check that the Server is running and published on that interface.";
  }
  if (codes.has("ENOTFOUND") || codes.has("EAI_AGAIN")) {
    return "The server hostname could not be resolved. Check the URL and DNS configuration.";
  }
  if (
    codes.has("ETIMEDOUT") ||
    codes.has("UND_ERR_CONNECT_TIMEOUT") ||
    codes.has("ENETUNREACH") ||
    codes.has("EHOSTUNREACH")
  ) {
    return "Check routing, the host firewall, and whether the Server port is reachable from this device.";
  }
  if (value.code === "server_unreachable") {
    return "Check the Server URL, confirm the Server is running, and verify that its port is published on a reachable interface.";
  }
  if (value.code === "machine_offline") {
    return 'Start the Odyshell Client on that machine with "ods client start".';
  }
  if (value.code === "machine_ping_timeout") {
    return 'Update and restart the Odyshell Client on that machine, then try "ods ping" again.';
  }
  return undefined;
}

function isExpected(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const record = error as Error & { expected?: unknown; code?: unknown };
  return (
    record.expected === true ||
    (typeof record.code === "string" && record.code.startsWith("commander."))
  );
}

function isStringOrNumber(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}
