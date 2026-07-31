import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  EventSinkReplayGuard,
  decryptEventSinkSecret,
  diagnosticTimelineMetadata,
  encryptEventSinkSecret,
  eventSinkDestination,
  eventSinkRetryAt,
  operationTimelineMetadata,
  redactTimelineMetadata,
  signedTimelineDelivery,
  verifyTimelineDeliverySignature,
} from "../apps/server/src/event-sinks.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64url");

describe("Timeline Event Sinks", () => {
  it("rejects local, private, metadata, credentialed and non-HTTPS destinations", async () => {
    const lookup = vi.fn(async (hostname: string) => {
      if (hostname === "private.example") {
        return [{ address: "10.0.0.4", family: 4 as const }];
      }
      return [{ address: "203.0.113.10", family: 4 as const }];
    });

    for (const endpoint of [
      "http://events.example/hook",
      "https://user:pass@events.example/hook",
      "https://localhost/hook",
      "https://127.0.0.1/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://private.example/hook",
    ]) {
      await expect(eventSinkDestination(endpoint, lookup)).rejects.toMatchObject({
        code: "event_sink_destination_denied",
      });
    }
  });

  it("pins a public DNS result and does not accept redirects implicitly", async () => {
    const destination = await eventSinkDestination(
      "https://events.example/odyshell",
      async () => [{ address: "93.184.216.34", family: 4 }],
    );

    expect(destination).toMatchObject({
      hostname: "events.example",
      address: "93.184.216.34",
      port: 443,
      path: "/odyshell",
    });
  });

  it("encrypts signing secrets at rest and detects the wrong key", () => {
    const encrypted = encryptEventSinkSecret("signing-secret-32-characters-long", encryptionKey);

    expect(encrypted).not.toContain("signing-secret");
    expect(decryptEventSinkSecret(encrypted, encryptionKey)).toBe(
      "signing-secret-32-characters-long",
    );
    expect(() =>
      decryptEventSinkSecret(encrypted, Buffer.alloc(32, 8).toString("base64url")),
    ).toThrow();
  });

  it("signs the exact stable payload and provides replay protection", () => {
    const delivery = signedTimelineDelivery(
      {
        version: "2026-07-31",
        sessionId: "session-id",
        exportedAt: "2026-07-31T09:00:00.000Z",
        events: [],
      },
      "signing-secret-32-characters-long",
      "delivery-id",
      "2026-07-31T09:00:00.000Z",
    );
    const expected = createHmac("sha256", "signing-secret-32-characters-long")
      .update(delivery.body)
      .digest("hex");

    expect(delivery.headers).toMatchObject({
      "x-odyshell-delivery": "delivery-id",
      "x-odyshell-timestamp": "2026-07-31T09:00:00.000Z",
      "x-odyshell-signature": `v1=${expected}`,
    });
    expect(
      verifyTimelineDeliverySignature(
        delivery.body,
        "signing-secret-32-characters-long",
        delivery.headers["x-odyshell-signature"]!,
      ),
    ).toBe(true);
    expect(
      verifyTimelineDeliverySignature(
        `${delivery.body}tampered`,
        "signing-secret-32-characters-long",
        delivery.headers["x-odyshell-signature"]!,
      ),
    ).toBe(false);
    const replay = new EventSinkReplayGuard();
    expect(replay.consume("delivery-id")).toBe(true);
    expect(replay.consume("delivery-id")).toBe(false);
  });

  it("retries timeouts with bounded backoff and reaches an inspectable terminal state", () => {
    expect(eventSinkRetryAt(1, 1_000)).toBe(2_000);
    expect(eventSinkRetryAt(5, 1_000)).toBe(301_000);
    expect(eventSinkRetryAt(6, 1_000)).toBeUndefined();
  });

  it("redacts before export according to the configured detail level", () => {
    const metadata = {
      machineId: "machine-id",
      path: "config/app.json",
      stdout: "safe output",
      token: "ods_secret_value",
      env: { API_KEY: "secret" },
    };

    expect(redactTimelineMetadata(metadata, "privacy-minimal")).toEqual({
      machineId: "machine-id",
    });
    expect(redactTimelineMetadata(metadata, "operational")).toEqual({
      machineId: "machine-id",
      path: "config/app.json",
    });
    expect(redactTimelineMetadata(metadata, "diagnostic")).toEqual({
      machineId: "machine-id",
      path: "config/app.json",
      stdout: "safe output",
    });
  });

  it("builds useful operational metadata without copying process environments or file content", () => {
    expect(
      operationTimelineMetadata({
        kind: "process.exec",
        program: "git",
        args: ["status"],
        cwd: ".",
        env: { CI: "true" },
      }),
    ).toEqual({
      kind: "process.exec",
      program: "git",
      args: ["status"],
      cwd: ".",
    });
    expect(
      operationTimelineMetadata({
        kind: "fs.write",
        path: "config.json",
        contentBase64: Buffer.from("secret").toString("base64"),
        createParents: false,
      }),
    ).toEqual({ kind: "fs.write", path: "config.json" });
  });

  it("keeps command text and bounded output diagnostic-only", () => {
    const metadata = {
      ...operationTimelineMetadata({
        kind: "process.shell",
        command: "printf safe",
        cwd: ".",
        env: {},
      }),
      ...diagnosticTimelineMetadata([
        { stream: "stdout", data: Buffer.from("safe output") },
        { stream: "result", data: Buffer.from("ignored") },
      ]),
    };

    expect(redactTimelineMetadata(metadata, "operational")).toEqual({
      kind: "process.shell",
      cwd: ".",
    });
    expect(redactTimelineMetadata(metadata, "diagnostic")).toEqual({
      kind: "process.shell",
      cwd: ".",
      command: "printf safe",
      stdout: "safe output",
    });
    expect(
      diagnosticTimelineMetadata([
        {
          stream: "stderr",
          data: Buffer.alloc(70 * 1024, "x"),
        },
      ]).stderr,
    ).toHaveLength(64 * 1024);
  });
});
