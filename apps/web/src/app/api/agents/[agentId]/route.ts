import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudAdminRouteIdentity,
} from "@/lib/cloud-route";

const agentIdSchema = z.string().uuid();

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
