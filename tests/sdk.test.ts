import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  Odyshell,
} from "../packages/sdk/src/index.js";

type CapturedRequest = {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

describe("Odyshell SDK", () => {
  it("keeps agent and administrator credentials on separate request surfaces", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = mockFetch(requests, () => ({ data: [] }));
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      adminKey: "admin-secret",
      fetch,
    });

    await ods.machines();
    await ods.adminMachines();

    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer agent-secret",
    });
    expect(requests[0]?.headers).not.toHaveProperty("x-odyshell-admin-key");
    expect(requests[1]?.headers).toMatchObject({
      "x-odyshell-admin-key": "admin-secret",
    });
    expect(requests[1]?.headers).not.toHaveProperty("authorization");
  });

  it("fails closed when the required credential is absent", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch,
    });

    await expect(ods.adminMachines()).rejects.toMatchObject({
      code: "credentials_missing",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not expose credentials through API errors", async () => {
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-super-secret",
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })),
    });

    const error = await ods.machines().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(JSON.stringify(error)).not.toContain("agent-super-secret");
    expect(String(error)).not.toContain("agent-super-secret");
  });

  it("runs a typed operation in a least-privilege temporary session", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = mockFetch(requests, (request) => {
      if (request.path === "/v1/machines") {
        return {
          data: [
            {
              id: "machine-id",
              name: "rpi5",
              status: "online",
              online: true,
              lastSeenAt: "2026-07-29T18:00:00.000Z",
              enrolledAt: "2026-07-29T17:00:00.000Z",
            },
          ],
        };
      }
      if (request.path === "/v1/sessions" && request.method === "POST") {
        return session("opening");
      }
      if (request.path === "/v1/sessions/session-id" && request.method === "GET") {
        return session("ready");
      }
      if (
        request.path === "/v1/sessions/session-id/operations" &&
        request.method === "POST"
      ) {
        return { id: "operation-id", status: "queued" };
      }
      if (request.path === "/v1/operations/operation-id") {
        return {
          id: "operation-id",
          sessionId: "session-id",
          action: {
            kind: "fs.write",
            path: "config/app.json",
            contentBase64: "eyJvayI6dHJ1ZX0=",
            createParents: true,
          },
          status: "succeeded",
          exitCode: 0,
          outputTruncated: false,
          events: [
            {
              sequence: 0,
              stream: "result",
              dataBase64: Buffer.from('{"bytesWritten":11}').toString("base64"),
            },
          ],
          createdAt: "2026-07-29T18:00:00.000Z",
          updatedAt: "2026-07-29T18:00:01.000Z",
        };
      }
      if (
        request.path === "/v1/sessions/session-id" &&
        request.method === "DELETE"
      ) {
        return { id: "session-id", status: "closed" };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.path}`);
    });
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch,
    });

    const result = await ods.fs.write({
      machine: "rpi5",
      path: "config/app.json",
      content: '{"ok":true}',
      createParents: true,
      ttlSeconds: 60,
      timeoutSeconds: 15,
    });

    expect(result.result).toEqual({ bytesWritten: 11 });
    expect(requests.find((request) => request.path === "/v1/sessions")?.body).toEqual({
      machineId: "machine-id",
      profile: "workspace",
      ttlSeconds: 60,
      capabilities: ["fs.write"],
    });
    expect(
      requests.find((request) => request.path.endsWith("/operations"))?.body,
    ).toEqual({
      action: {
        kind: "fs.write",
        path: "config/app.json",
        contentBase64: Buffer.from('{"ok":true}').toString("base64"),
        createParents: true,
      },
      timeoutSeconds: 15,
      maxOutputBytes: 1024 * 1024,
    });
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/v1/sessions/session-id",
    });
  });
});

function session(status: "opening" | "ready") {
  return {
    id: "session-id",
    machineId: "machine-id",
    profile: "workspace",
    capabilities: ["fs.write"],
    status,
    expiresAt: "2026-07-29T19:00:00.000Z",
    createdAt: "2026-07-29T18:00:00.000Z",
  };
}

function mockFetch(
  requests: CapturedRequest[],
  responder: (request: CapturedRequest) => unknown,
): typeof globalThis.fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const request: CapturedRequest = {
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      headers,
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) as unknown }
        : {}),
    };
    requests.push(request);
    return new Response(JSON.stringify(responder(request)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}
