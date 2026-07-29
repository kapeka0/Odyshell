import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  workspaces: defineTable({
    id: v.string(),
    slug: v.string(),
    name: v.string(),
    createdAt: v.number(),
  })
    .index("by_public_id", ["id"])
    .index("by_slug", ["slug"]),

  machines: defineTable({
    workspaceId: v.string(),
    id: v.string(),
    name: v.string(),
    publicKey: v.string(),
    status: v.string(),
    runtime: v.optional(v.any()),
    lastSeenAt: v.optional(v.number()),
    enrolledAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_public_id", ["id"])
    .index("by_workspace_enrolled", ["workspaceId", "enrolledAt"]),

  enrollmentTokens: defineTable({
    workspaceId: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_token_hash", ["tokenHash"]),

  agentTokens: defineTable({
    workspaceId: v.string(),
    id: v.string(),
    name: v.string(),
    tokenHash: v.string(),
    machineIds: v.array(v.string()),
    capabilities: v.array(v.string()),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_public_id", ["id"])
    .index("by_token_hash", ["tokenHash"])
    .index("by_workspace_created", ["workspaceId", "createdAt"]),

  sessions: defineTable({
    workspaceId: v.string(),
    id: v.string(),
    machineId: v.string(),
    principalId: v.string(),
    profile: v.string(),
    capabilities: v.array(v.string()),
    status: v.string(),
    expiresAt: v.number(),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["id"])
    .index("by_principal_created", ["principalId", "createdAt"])
    .index("by_machine", ["machineId"]),

  operations: defineTable({
    workspaceId: v.string(),
    id: v.string(),
    sessionId: v.string(),
    principalId: v.string(),
    action: v.any(),
    status: v.string(),
    timeoutSeconds: v.number(),
    maxOutputBytes: v.number(),
    exitCode: v.optional(v.number()),
    error: v.optional(v.string()),
    outputTruncated: v.boolean(),
    idempotencyKey: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["id"])
    .index("by_session_created", ["sessionId", "createdAt"])
    .index("by_principal_idempotency", ["principalId", "idempotencyKey"]),

  operationEvents: defineTable({
    workspaceId: v.string(),
    operationId: v.string(),
    sequence: v.number(),
    stream: v.string(),
    dataBase64: v.string(),
    createdAt: v.number(),
  }).index("by_operation_sequence", ["operationId", "sequence"]),

  auditEvents: defineTable({
    workspaceId: v.string(),
    id: v.string(),
    principalId: v.string(),
    action: v.string(),
    targetType: v.string(),
    targetId: v.string(),
    metadata: v.any(),
    createdAt: v.number(),
  })
    .index("by_public_id", ["id"])
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_principal_created", ["principalId", "createdAt"]),
});
