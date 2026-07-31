import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";

const sessionIdSchema = z.string().uuid();

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = sessionIdSchema.safeParse((await params).sessionId);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_session_id" }, { status: 400 });
  }
  try {
    const result = await cloudRequest<{
      id: string;
      status: string;
      transitioned: boolean;
    }>("/v1/internal/cloud/sessions/cancel", authorization.identity, {
      extraBody: { sessionId: parsed.data },
    });
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return cloudRouteError(error);
  }
}
