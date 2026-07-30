import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";

const tokenIdSchema = z.string().uuid();

async function mutateAgentAccess(
  operation: "delete" | "revoke",
  _request: Request,
  { params }: { params: Promise<{ tokenId: string }> },
) {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = tokenIdSchema.safeParse((await params).tokenId);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_agent_access_id" }, { status: 400 });
  }
  try {
    const result = await cloudRequest<{
      id: string;
      name: string;
      status: "deleted" | "revoked";
      closedSessions: number;
    }>(
      `/v1/internal/cloud/agent-access/${operation}`,
      authorization.identity,
      {
        extraBody: { tokenId: parsed.data },
      },
    );
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return cloudRouteError(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ tokenId: string }> },
) {
  return mutateAgentAccess("revoke", request, context);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ tokenId: string }> },
) {
  return mutateAgentAccess("delete", request, context);
}
