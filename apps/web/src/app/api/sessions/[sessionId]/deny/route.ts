import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest, type CloudSession } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";

const sessionIdSchema = z.string().uuid();

export async function POST(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = sessionIdSchema.safeParse((await context.params).sessionId);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_session_id" }, { status: 400 });
  }
  try {
    const result = await cloudRequest<{ session: CloudSession; delivery: "sent" }>(
      `/v1/internal/sessions/${parsed.data}/deny`,
      authorization.identity,
    );
    return NextResponse.json(result);
  } catch (error) {
    return cloudRouteError(error);
  }
}
