import { v } from "convex/values";
import {
  mutationGeneric as mutation,
  queryGeneric as query,
  type GenericMutationCtx,
  type GenericQueryCtx,
} from "convex/server";

type QueryCtx = GenericQueryCtx<any>;
type MutationCtx = GenericMutationCtx<any>;

const DEFAULT_WORKSPACE_ID = "default";

function authorize(serviceKey: string): void {
  const expected = process.env.ODYSHELL_SERVICE_KEY;
  if (!expected || serviceKey !== expected) {
    throw new Error("Unauthorized Odyshell server");
  }
}

async function byPublicId<Table extends "machines" | "agentTokens" | "sessions" | "operations">(
  ctx: QueryCtx | MutationCtx,
  table: Table,
  id: string,
): Promise<any | null> {
  return await ctx.db
    .query(table)
    .withIndex("by_public_id", (index) => index.eq("id", id))
    .unique();
}

async function appendAudit(
  ctx: MutationCtx,
  input: {
    principalId: string;
    action: string;
    targetType: string;
    targetId: string;
    metadata?: unknown;
    createdAt?: number;
    id: string;
  },
): Promise<void> {
  const createdAt = input.createdAt ?? Date.now();
  await ctx.db.insert("auditEvents", {
    workspaceId: DEFAULT_WORKSPACE_ID,
    id: input.id,
    principalId: input.principalId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    metadata: input.metadata ?? {},
    createdAt,
  });
}

async function ensureWorkspace(ctx: MutationCtx): Promise<void> {
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_public_id", (index) => index.eq("id", DEFAULT_WORKSPACE_ID))
    .unique();
  if (!workspace) {
    await ctx.db.insert("workspaces", {
      id: DEFAULT_WORKSPACE_ID,
      slug: "default",
      name: "Default workspace",
      createdAt: Date.now(),
    });
  }
}

export const read = query({
  args: {
    serviceKey: v.string(),
    operation: v.string(),
    input: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    authorize(args.serviceKey);
    const input = (args.input ?? {}) as Record<string, any>;

    switch (args.operation) {
      case "health":
        return { ok: true };
      case "counts": {
        const [
          machines,
          enrollmentTokens,
          agentTokens,
          sessions,
          operations,
          operationEvents,
          auditEvents,
        ] = await Promise.all([
          ctx.db.query("machines").collect(),
          ctx.db.query("enrollmentTokens").collect(),
          ctx.db.query("agentTokens").collect(),
          ctx.db.query("sessions").collect(),
          ctx.db.query("operations").collect(),
          ctx.db.query("operationEvents").collect(),
          ctx.db.query("auditEvents").collect(),
        ]);
        return {
          machines: machines.length,
          enrollmentTokens: enrollmentTokens.length,
          agentTokens: agentTokens.length,
          sessions: sessions.length,
          operations: operations.length,
          operationEvents: operationEvents.length,
          auditEvents: auditEvents.length,
        };
      }
      case "agentByTokenHash": {
        const token = await ctx.db
          .query("agentTokens")
          .withIndex("by_token_hash", (index) => index.eq("tokenHash", input.tokenHash))
          .unique();
        return token && token.revokedAt === undefined && token.expiresAt > Date.now() ? token : null;
      }
      case "listAgentTokens":
        return await ctx.db
          .query("agentTokens")
          .withIndex("by_workspace_created", (index) =>
            index.eq("workspaceId", DEFAULT_WORKSPACE_ID),
          )
          .order("desc")
          .take(200);
      case "listMachines": {
        const machines = await ctx.db
          .query("machines")
          .withIndex("by_workspace_enrolled", (index) =>
            index.eq("workspaceId", DEFAULT_WORKSPACE_ID),
          )
          .order("asc")
          .collect();
        const machineIds = input.machineIds as string[] | undefined;
        return machines.filter(
          (machine) =>
            (input.includeRevoked || machine.revokedAt === undefined) &&
            (!machineIds || machineIds.includes(machine.id)),
        );
      }
      case "activeMachinesExist": {
        const machineIds = input.machineIds as string[];
        const found = await Promise.all(
          machineIds.map((id) => byPublicId(ctx, "machines", id)),
        );
        return found.every((machine) => machine && machine.revokedAt === undefined);
      }
      case "machinePublicKey": {
        const machine = await byPublicId(ctx, "machines", input.machineId);
        return machine && machine.revokedAt === undefined ? machine.publicKey : null;
      }
      case "listSessions": {
        const sessions = await ctx.db
          .query("sessions")
          .withIndex("by_principal_created", (index) =>
            index.eq("principalId", input.principalId),
          )
          .order("desc")
          .take(100);
        const machines = await Promise.all(
          sessions.map((session) => byPublicId(ctx, "machines", session.machineId)),
        );
        return sessions.map((session, index) => ({
          ...session,
          machineName: machines[index]?.name ?? "Unknown machine",
        }));
      }
      case "session": {
        const session = await byPublicId(ctx, "sessions", input.sessionId);
        return session?.principalId === input.principalId ? session : null;
      }
      case "activeSession": {
        const session = await byPublicId(ctx, "sessions", input.sessionId);
        return session?.principalId === input.principalId &&
          ["opening", "ready"].includes(session.status)
          ? session
          : null;
      }
      case "operationByIdempotency":
        return (
          (await ctx.db
            .query("operations")
            .withIndex("by_principal_idempotency", (index) =>
              index.eq("principalId", input.principalId),
            )
            .filter((filter) =>
              filter.eq(filter.field("idempotencyKey"), input.idempotencyKey),
            )
            .unique()) ?? null
        );
      case "sessionForOperation": {
        const session = await byPublicId(ctx, "sessions", input.sessionId);
        return session?.principalId === input.principalId ? session : null;
      }
      case "operation": {
        const operation = await byPublicId(ctx, "operations", input.operationId);
        if (!operation || operation.principalId !== input.principalId) return null;
        const events = await ctx.db
          .query("operationEvents")
          .withIndex("by_operation_sequence", (index) =>
            index.eq("operationId", input.operationId),
          )
          .order("asc")
          .collect();
        return { ...operation, events };
      }
      case "operationTarget": {
        const operation = await byPublicId(ctx, "operations", input.operationId);
        if (!operation || operation.principalId !== input.principalId) return null;
        const session = await byPublicId(ctx, "sessions", operation.sessionId);
        return session ? { machineId: session.machineId, status: operation.status } : null;
      }
      case "operationExists": {
        const operation = await byPublicId(ctx, "operations", input.operationId);
        return operation?.principalId === input.principalId;
      }
      case "operationEvents":
        return await ctx.db
          .query("operationEvents")
          .withIndex("by_operation_sequence", (index) =>
            index.eq("operationId", input.operationId),
          )
          .filter((filter) => filter.gt(filter.field("sequence"), input.afterSequence))
          .order("asc")
          .collect();
      case "operationStatus":
        return (await byPublicId(ctx, "operations", input.operationId))?.status ?? null;
      case "audit":
        return input.principalId
          ? await ctx.db
              .query("auditEvents")
              .withIndex("by_principal_created", (index) =>
                index.eq("principalId", input.principalId),
              )
              .order("desc")
              .take(input.limit)
          : await ctx.db
              .query("auditEvents")
              .withIndex("by_workspace_created", (index) =>
                index.eq("workspaceId", DEFAULT_WORKSPACE_ID),
              )
              .order("desc")
              .take(input.limit);
      default:
        throw new Error(`Unknown database read operation: ${args.operation}`);
    }
  },
});

export const write = mutation({
  args: {
    serviceKey: v.string(),
    operation: v.string(),
    input: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    authorize(args.serviceKey);
    const input = (args.input ?? {}) as Record<string, any>;
    const now = Date.now();

    switch (args.operation) {
      case "initialize": {
        await ensureWorkspace(ctx);
        const machines = await ctx.db
          .query("machines")
          .withIndex("by_workspace_enrolled", (index) =>
            index.eq("workspaceId", DEFAULT_WORKSPACE_ID),
          )
          .collect();
        await Promise.all(
          machines
            .filter((machine) => machine.status !== "offline")
            .map((machine) => ctx.db.patch(machine._id, { status: "offline" })),
        );
        return { ok: true };
      }
      case "createEnrollmentToken":
        await ctx.db.insert("enrollmentTokens", {
          workspaceId: DEFAULT_WORKSPACE_ID,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          createdAt: now,
        });
        return { ok: true };
      case "createAgentToken":
        await ctx.db.insert("agentTokens", {
          workspaceId: DEFAULT_WORKSPACE_ID,
          id: input.id,
          name: input.name,
          tokenHash: input.tokenHash,
          machineIds: input.machineIds,
          capabilities: input.capabilities,
          expiresAt: input.expiresAt,
          createdAt: now,
        });
        return { ok: true };
      case "revokeAgentToken": {
        const token = await byPublicId(ctx, "agentTokens", input.tokenId);
        if (!token) return null;
        const revokedAt = token.revokedAt ?? now;
        await ctx.db.patch(token._id, { revokedAt });
        return { ...token, revokedAt };
      }
      case "enrollMachine": {
        const enrollment = await ctx.db
          .query("enrollmentTokens")
          .withIndex("by_token_hash", (index) => index.eq("tokenHash", input.tokenHash))
          .unique();
        if (!enrollment || enrollment.usedAt !== undefined || enrollment.expiresAt <= now) {
          return null;
        }
        await ctx.db.patch(enrollment._id, { usedAt: now });
        await ctx.db.insert("machines", {
          workspaceId: DEFAULT_WORKSPACE_ID,
          id: input.machineId,
          name: input.name,
          publicKey: input.publicKey,
          status: "offline",
          enrolledAt: now,
        });
        return { machineId: input.machineId, name: input.name };
      }
      case "machineOffline": {
        const machine = await byPublicId(ctx, "machines", input.machineId);
        if (machine) await ctx.db.patch(machine._id, { status: "offline" });
        return { ok: true };
      }
      case "machineOnline": {
        const machine = await byPublicId(ctx, "machines", input.machineId);
        if (!machine || machine.revokedAt !== undefined) return false;
        await ctx.db.patch(machine._id, {
          status: "online",
          lastSeenAt: now,
          ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        });
        return true;
      }
      case "heartbeat": {
        const machine = await byPublicId(ctx, "machines", input.machineId);
        if (machine && machine.revokedAt === undefined) {
          await ctx.db.patch(machine._id, { status: "online", lastSeenAt: now });
        }
        return { ok: true };
      }
      case "revokeMachine": {
        const machine = await byPublicId(ctx, "machines", input.machineId);
        if (!machine || machine.revokedAt !== undefined) return null;
        await ctx.db.patch(machine._id, { revokedAt: now, status: "offline" });
        const sessions = await ctx.db
          .query("sessions")
          .withIndex("by_machine", (index) => index.eq("machineId", machine.id))
          .collect();
        const activeSessions = sessions.filter((session) =>
          ["opening", "ready", "closing"].includes(session.status),
        );
        const operations = (
          await Promise.all(
            activeSessions.map((session) =>
              ctx.db
                .query("operations")
                .withIndex("by_session_created", (index) =>
                  index.eq("sessionId", session.id),
                )
                .collect(),
            ),
          )
        )
          .flat()
          .filter((operation) => ["queued", "delivered", "running"].includes(operation.status));
        await Promise.all([
          ...activeSessions.map((session) =>
            ctx.db.patch(session._id, {
              status: "closed",
              error: "machine_revoked",
              updatedAt: now,
            }),
          ),
          ...operations.map((operation) =>
            ctx.db.patch(operation._id, {
              status: "cancelled",
              error: "machine_revoked",
              updatedAt: now,
            }),
          ),
        ]);
        return {
          id: machine.id,
          name: machine.name,
          revokedAt: now,
          operationIds: operations.map((operation) => operation.id),
          sessionIds: activeSessions.map((session) => session.id),
        };
      }
      case "expireAgentSessions": {
        const sessions = await ctx.db
          .query("sessions")
          .withIndex("by_principal_created", (index) =>
            index.eq("principalId", input.principalId),
          )
          .collect();
        const active = sessions.filter((session) =>
          ["opening", "ready"].includes(session.status),
        );
        await Promise.all(
          active.map((session) =>
            ctx.db.patch(session._id, { status: "expired", updatedAt: now }),
          ),
        );
        return active.map((session) => ({ id: session.id, machineId: session.machineId }));
      }
      case "createSession":
        await ctx.db.insert("sessions", {
          workspaceId: DEFAULT_WORKSPACE_ID,
          id: input.id,
          machineId: input.machineId,
          principalId: input.principalId,
          profile: input.profile,
          capabilities: input.capabilities,
          status: "opening",
          expiresAt: input.expiresAt,
          createdAt: now,
          updatedAt: now,
        });
        return { ok: true };
      case "markSessionClosing": {
        const session = await byPublicId(ctx, "sessions", input.sessionId);
        if (session) await ctx.db.patch(session._id, { status: "closing", updatedAt: now });
        return { ok: true };
      }
      case "sessionOpened": {
        const session = await byPublicId(ctx, "sessions", input.sessionId);
        if (!session || session.status !== "opening") return null;
        await ctx.db.patch(session._id, { status: "ready", updatedAt: now, error: undefined });
        return { principalId: session.principalId };
      }
      case "sessionOpenFailed": {
        const session = await byPublicId(ctx, "sessions", input.sessionId);
        if (!session || session.status !== "opening") return null;
        await ctx.db.patch(session._id, {
          status: "failed",
          updatedAt: now,
          error: input.error,
        });
        return { principalId: session.principalId };
      }
      case "sessionClosed": {
        const session = await byPublicId(ctx, "sessions", input.sessionId);
        if (!session || !["opening", "ready", "closing"].includes(session.status)) return null;
        const status = session.expiresAt <= now ? "expired" : "closed";
        await ctx.db.patch(session._id, { status, updatedAt: now });
        return { principalId: session.principalId, status };
      }
      case "createOperation":
        await ctx.db.insert("operations", {
          workspaceId: DEFAULT_WORKSPACE_ID,
          id: input.id,
          sessionId: input.sessionId,
          principalId: input.principalId,
          action: input.action,
          status: "queued",
          timeoutSeconds: input.timeoutSeconds,
          maxOutputBytes: input.maxOutputBytes,
          outputTruncated: false,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          createdAt: now,
          updatedAt: now,
        });
        return { ok: true };
      case "markOperationDelivered": {
        const operation = await byPublicId(ctx, "operations", input.operationId);
        if (operation) {
          await ctx.db.patch(operation._id, { status: "delivered", updatedAt: now });
        }
        return { ok: true };
      }
      case "operationStarted": {
        const operation = await byPublicId(ctx, "operations", input.operationId);
        if (operation && ["queued", "delivered"].includes(operation.status)) {
          await ctx.db.patch(operation._id, { status: "running", updatedAt: now });
        }
        return { ok: true };
      }
      case "operationEvent": {
        const existing = await ctx.db
          .query("operationEvents")
          .withIndex("by_operation_sequence", (index) =>
            index.eq("operationId", input.operationId),
          )
          .filter((filter) => filter.eq(filter.field("sequence"), input.sequence))
          .unique();
        if (!existing) {
          await ctx.db.insert("operationEvents", {
            workspaceId: DEFAULT_WORKSPACE_ID,
            operationId: input.operationId,
            sequence: input.sequence,
            stream: input.stream,
            dataBase64: input.dataBase64,
            createdAt: now,
          });
        }
        return { ok: true };
      }
      case "operationCompleted": {
        const operation = await byPublicId(ctx, "operations", input.operationId);
        if (!operation || !["queued", "delivered", "running"].includes(operation.status)) {
          return null;
        }
        await ctx.db.patch(operation._id, {
          status: input.status,
          exitCode: input.exitCode ?? undefined,
          ...(input.error === undefined ? { error: undefined } : { error: input.error }),
          outputTruncated: input.outputTruncated,
          updatedAt: now,
        });
        return { principalId: operation.principalId };
      }
      case "audit":
        await appendAudit(ctx, input as Parameters<typeof appendAudit>[1]);
        return { ok: true };
      case "expireSessions": {
        const sessions = await ctx.db.query("sessions").collect();
        const tokens = await ctx.db.query("agentTokens").collect();
        const tokenById = new Map(tokens.map((token) => [token.id, token]));
        const expired = sessions.filter((session) => {
          if (!["opening", "ready"].includes(session.status)) return false;
          const token = tokenById.get(session.principalId);
          return (
            session.expiresAt <= now ||
            (token !== undefined && (token.expiresAt <= now || token.revokedAt !== undefined))
          );
        });
        await Promise.all(
          expired.map((session) =>
            ctx.db.patch(session._id, { status: "expired", updatedAt: now }),
          ),
        );
        return expired.map((session) => ({ id: session.id, machineId: session.machineId }));
      }
      default:
        throw new Error(`Unknown database write operation: ${args.operation}`);
    }
  },
});
