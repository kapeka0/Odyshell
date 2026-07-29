import { describe, expect, it } from "vitest";
import { errorReport, ServerConnectionError } from "../apps/cli/src/errors.js";

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
});
