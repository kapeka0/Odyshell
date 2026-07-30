import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";

const tokenIdSchema = z.string().uuid();

export async function DELETE(
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
      status: "revoked";
      closedSessions: number;
    }>("/v1/internal/cloud/agent-access/revoke", authorization.identity, {
      extraBody: { tokenId: parsed.data },
    });
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return cloudRouteError(error);
  }
}
