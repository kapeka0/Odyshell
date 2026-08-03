import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";
import { sessionApprovalRequestIdSchema } from "@/lib/session-approval";

const requestSchema = z.object({
  requestId: sessionApprovalRequestIdSchema,
});

export async function POST(request: Request) {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = requestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_session_request" },
      { status: 400 },
    );
  }
  try {
    const result = await cloudRequest<{
      denied: true;
      requestId: string;
    }>(
      "/v1/internal/cloud/session-requests/deny",
      authorization.identity,
      { extraBody: { requestId: parsed.data.requestId } },
    );
    return NextResponse.json(result);
  } catch (error) {
    return cloudRouteError(error);
  }
}
