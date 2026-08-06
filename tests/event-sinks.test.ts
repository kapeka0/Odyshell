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
  privacyMinimalOperationMetadata,
  redactEventSinkMetadata,
  redactRecentHostShellCommand,
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
      stdout: "safe output",
    });
    expect(redactTimelineMetadata(metadata, "diagnostic")).toEqual({
      machineId: "machine-id",
      path: "config/app.json",
      stdout: "safe output",
      token: "ods_secret_value",
    });
  });

  it("never exports Host Shell environment or stdin payloads", () => {
    const metadata = {
      machineId: "machine-id",
      kind: "host.shell",
      command: "deploy",
      env: { DEPLOY_TOKEN: "environment-secret" },
      stdinBase64: Buffer.from("stdin-secret").toString("base64"),
    };

    for (const level of ["privacy-minimal", "operational", "diagnostic"] as const) {
      const exported = redactTimelineMetadata(metadata, level);
      expect(JSON.stringify(exported)).not.toMatch(
        /DEPLOY_TOKEN|environment-secret|stdinBase64|stdin-secret/u,
      );
    }
  });

  it("removes nested operation constraints from privacy-minimal scopes", () => {
    expect(
      redactTimelineMetadata(
        {
          scopes: [
            {
              machineId: "machine-1",
              capabilities: ["fs.read", "process.exec"],
              operations: [
                { kind: "fs.read", path: "/srv/private.env" },
                { kind: "process.exec", program: "cat", args: ["/srv/private.env"] },
              ],
            },
          ],
        },
        "privacy-minimal",
      ),
    ).toEqual({
      scopes: [
        {
          machineId: "machine-1",
          capabilities: ["fs.read", "process.exec"],
        },
      ],
    });
  });

  it("builds useful operational metadata without copying process environments or file content", () => {
    expect(
      operationTimelineMetadata({
        kind: "process.exec",
        program: "git",
        args: ["status"],
        cwd: ".",
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

  it("keeps command text and bounded output operational with redaction", () => {
    const metadata = {
      ...operationTimelineMetadata({
        kind: "host.shell",
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
      kind: "host.shell",
      cwd: ".",
      command: "printf safe",
      stdout: "safe output",
    });
    expect(redactTimelineMetadata(metadata, "diagnostic")).toEqual({
      kind: "host.shell",
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

  it("redacts recent Host Shell commands before authenticated Session inspection", () => {
    expect(redactRecentHostShellCommand("curl --token hunter2")).toBe(
      "curl --token [REDACTED]",
    );
    expect(
      redactRecentHostShellCommand(
        "tool --password 'correct horse battery staple' status",
      ),
    ).toBe("tool --password [REDACTED] status");
    expect(
      redactRecentHostShellCommand(
        "curl https://user:pass@example.com --api-key=plain-secret",
      ),
    ).toBe("curl https://[REDACTED]@example.com --api-key=[REDACTED]");
    expect(
      redactRecentHostShellCommand(
        "tool --password='correct horse battery staple' status",
      ),
    ).toBe("tool --password=[REDACTED] status");
    expect(
      redactRecentHostShellCommand(
        "TOKEN='correct horse battery staple' command",
      ),
    ).toBe("TOKEN=[REDACTED] command");
  });

  it("redacts compact secret assignments in operational arguments", () => {
    expect(
      redactTimelineMetadata(
        { args: ["-p=hunter2", "-k:api-secret", "--token=ods_secret_value"] },
        "operational",
      ),
    ).toEqual({
      args: ["-p=[REDACTED]", "-k:[REDACTED]", "--token=[REDACTED]"],
    });
  });

  it("exports privacy-minimal Timeline attribution and verified results", () => {
    expect(
      redactTimelineMetadata(
        {
          kind: "process.exec",
          program: "git",
          args: ["status"],
          actorAgentId: "agent-a",
          exitCode: 0,
          outcome: "succeeded",
          summary: "Dependency check completed",
          stdout: "private output",
          path: "/private/path",
        },
        "privacy-minimal",
      ),
    ).toEqual({
      kind: "process.exec",
      actorAgentId: "agent-a",
      exitCode: 0,
      outcome: "succeeded",
    });
  });

  it("keeps privacy-minimal Event Sinks free of command and Agent content", () => {
    const metadata = {
      kind: "process.exec",
      machineId: "machine-a",
      actorAgentId: "agent-a",
      status: "succeeded",
      exitCode: 0,
      program: "git",
      args: ["status"],
      command: "git status",
      stdout: "secret output",
      stderr: "secret error",
      env: { TOKEN: "secret" },
      stdinBase64: "c2VjcmV0",
      summary: "Agent-authored detail",
    };

    expect(redactEventSinkMetadata(metadata, "privacy-minimal")).toEqual({
      kind: "process.exec",
      machineId: "machine-a",
      actorAgentId: "agent-a",
      status: "succeeded",
      exitCode: 0,
    });
    expect(redactEventSinkMetadata(metadata, "operational")).toEqual({
      kind: "process.exec",
      machineId: "machine-a",
      actorAgentId: "agent-a",
      status: "succeeded",
      exitCode: 0,
    });
    expect(redactEventSinkMetadata(metadata, "diagnostic")).toEqual({
      kind: "process.exec",
      machineId: "machine-a",
      actorAgentId: "agent-a",
      status: "succeeded",
      exitCode: 0,
    });
  });

  it("drops Agent-authored summaries from every Event Sink detail level", () => {
    const metadata = {
      kind: "session.completed",
      outcome: "succeeded",
      summary: "Agent-authored top-level summary",
      report: {
        summary: "Agent-authored nested summary",
        status: "succeeded",
      },
    };

    for (const level of ["privacy-minimal", "operational", "diagnostic"] as const) {
      const exported = JSON.stringify(redactEventSinkMetadata(metadata, level));
      expect(exported).not.toContain("Agent-authored");
      expect(exported).not.toContain("summary");
    }
  });

  it("redacts nested process credentials in operational exports", () => {
    const metadata = {
      kind: "process.exec",
      program: "/private/tools/database-client",
      args: ["--password", "hunter2", "--api-key=abc123", "status"],
      command: "curl --token secret https://private.example",
      summary: "stdout contained ods_session_secret",
    };

    for (const level of ["privacy-minimal", "operational"] as const) {
      const exported = JSON.stringify(redactTimelineMetadata(metadata, level));
      expect(exported).not.toMatch(
        /hunter2|abc123|ods_session_secret/u,
      );
    }
    expect(JSON.stringify(redactTimelineMetadata(metadata, "diagnostic"))).toContain("hunter2");
  });

  it("keeps useful operational paths and output while removing common secrets", () => {
    const exported = redactTimelineMetadata(
      {
        command: "curl https://user:pass@example.com/config --token ods_secret_123456789",
        path: "/srv/app/config.json",
        stdout: "Authorization: Bearer abc.def.ghi\nAPI_KEY=sk_live_123456789012",
      },
      "operational",
    );
    expect(exported.path).toBe("/srv/app/config.json");
    expect(JSON.stringify(exported)).not.toMatch(/user:pass|abc\.def|sk_live/u);
    expect(JSON.stringify(exported)).toContain("[REDACTED]");
  });

  it("keeps Host Shell command text out of the privacy-minimal Session timeline", () => {
    expect(
      privacyMinimalOperationMetadata({
        kind: "host.shell",
        command: "curl --token super-secret https://example.com",
        cwd: ".",
        env: {},
      }),
    ).toEqual({ kind: "host.shell" });
    expect(
      privacyMinimalOperationMetadata({
        kind: "process.exec",
        program: "tool",
        args: ["--password", "hunter2", "status"],
        cwd: ".",
      }),
    ).toEqual({
      kind: "process.exec",
      program: "tool",
      args: ["--password", "[REDACTED]", "status"],
    });
  });

  it("fails closed when command arguments could contain credentials", () => {
    const shell = privacyMinimalOperationMetadata({
      kind: "host.shell",
      command: 'curl --password="secret" -H Authorization: Bearer abc123 https://user:pass@example.com',
      cwd: "/private/workspace",
      env: {},
    });
    const process = privacyMinimalOperationMetadata({
      kind: "process.exec",
      program: "database-client",
      args: ["-p", "hunter2", "--api-key=abc123", "postgres://user:pass@db/app"],
      cwd: "/private/workspace",
    });

    expect(JSON.stringify({ shell, process })).not.toMatch(
      /secret|hunter2|abc123|user:pass|private\/workspace/u,
    );
    expect(shell).toEqual({ kind: "host.shell" });
    expect(process).toEqual({
      kind: "process.exec",
      program: "database-client",
      args: ["-p", "[REDACTED]", "--api-key=[REDACTED]", "[REDACTED]"],
    });
  });

  it("does not retain filesystem paths or Docker container names", () => {
    const filesystem = privacyMinimalOperationMetadata({
      kind: "fs.read",
      path: "/srv/private/customer-a/credentials.json",
    });
    const docker = privacyMinimalOperationMetadata({
      kind: "docker.logs",
      container: "payments-production-secret",
      tail: 100,
      timestamps: false,
    });

    expect(filesystem).toEqual({ kind: "fs.read" });
    expect(docker).toEqual({ kind: "docker.logs" });
    expect(JSON.stringify({ filesystem, docker })).not.toMatch(
      /customer-a|credentials|payments-production-secret/u,
    );
  });

  it("retains executable identity without its private path", () => {
    const process = privacyMinimalOperationMetadata({
      kind: "process.exec",
      program: "/srv/private-customer/bin/deploy-tool",
      args: [],
      cwd: "/srv/private-customer",
    });
    const shell = privacyMinimalOperationMetadata({
      kind: "host.shell",
      command: '"C:\\Customers\\Private\\audit.exe" --version',
      cwd: "C:\\Customers\\Private",
      env: {},
    });

    expect(process).toEqual({
      kind: "process.exec",
      program: "deploy-tool",
      args: [],
    });
    expect(shell).toEqual({ kind: "host.shell" });
    expect(JSON.stringify({ process, shell })).not.toMatch(
      /private-customer|Customers|Private/u,
    );
  });
});
