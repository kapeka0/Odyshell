import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudAdminRouteIdentity,
} from "@/lib/cloud-route";

const agentIdSchema = z.string().uuid();
const agentRoleSchema = z.object({ role: z.enum(["standard", "operator"]) }).strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const authorization = await requireCloudAdminRouteIdentity();
  if (authorization.response) return authorization.response;
  const [parsedId, body] = await Promise.all([
    agentIdSchema.safeParseAsync((await params).agentId),
    request.json().catch(() => null),
  ]);
  const parsedBody = agentRoleSchema.safeParse(body);
  if (!parsedId.success || !parsedBody.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const result = await cloudRequest<{
      agent: { id: string; role: "standard" | "operator" };
      revokedSessions: number;
    }>("/v1/internal/cloud/agents/role", authorization.identity, {
      extraBody: { agentId: parsedId.data, agentRole: parsedBody.data.role },
    });
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return cloudRouteError(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const authorization = await requireCloudAdminRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = agentIdSchema.safeParse((await params).agentId);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400 });
  }
  try {
    const result = await cloudRequest<{
      deleted: true;
      deletedAgents: number;
      terminatedSessions: number;
    }>("/v1/internal/cloud/agents/delete", authorization.identity, {
      extraBody: { agentId: parsed.data },
    });
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return cloudRouteError(error);
  }
}
