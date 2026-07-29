import { afterEach, describe, expect, it, vi } from "vitest";
import {
  errorReport,
  ExpectedError,
  printCliError,
  ServerConnectionError,
} from "../apps/cli/src/errors.js";
import { ApiError } from "../apps/cli/src/api.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI error reporting", () => {
  it("preserves network causes and stack traces", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 192.0.2.10:4100"), {
      code: "ECONNREFUSED",
      errno: -4078,
      syscall: "connect",
      address: "192.0.2.10",
      port: 4100,
    });
    const error = new ServerConnectionError("http://192.0.2.10:4100", cause);

    expect(errorReport(error)).toMatchObject({
      name: "ServerConnectionError",
      code: "server_unreachable",
      stack: expect.stringContaining("ServerConnectionError"),
      cause: {
        name: "Error",
        code: "ECONNREFUSED",
        errno: -4078,
        syscall: "connect",
        address: "192.0.2.10",
        port: 4100,
        stack: expect.stringContaining("ECONNREFUSED"),
      },
    });
  });

  it("serializes non-error values without throwing", () => {
    expect(errorReport("plain failure")).toEqual({
      name: "Error",
      message: "plain failure",
    });
  });

  it("keeps expected operational errors concise", () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
      lines.push(values.join(" "));
    });

    printCliError(
      new ExpectedError(
        'Machine "desktop-test" is enrolled, but its Odyshell Client is not connected to the Server.',
        "machine_offline",
      ),
      false,
    );

    const output = lines.join("\n");
    expect(output).toContain("machine_offline");
    expect(output).toContain("ods client start");
    expect(output).not.toContain("Stack trace:");
  });

  it("explains how to recover from an unresponsive ping client", () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
      lines.push(values.join(" "));
    });

    printCliError(
      new ApiError(
        504,
        "machine_ping_timeout",
        { possibleCause: "client_outdated_or_unresponsive" },
      ),
      false,
    );

    const output = lines.join("\n");
    expect(output).toContain("did not answer the ping");
    expect(output).toContain("machine_ping_timeout");
    expect(output).toContain("Update and restart");
    expect(output).not.toContain("Stack trace:");
  });

  it("prints stack traces for unexpected errors", () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
      lines.push(values.join(" "));
    });

    printCliError(new Error("unexpected failure"), false);

    const output = lines.join("\n");
    expect(output).toContain("Stack trace:");
    expect(output).toContain("unexpected failure");
  });
});
