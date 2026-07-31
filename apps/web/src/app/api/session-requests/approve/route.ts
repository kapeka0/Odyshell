import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";
import { sessionApprovalCodeSchema } from "@/lib/session-approval";

const requestSchema = z.object({
  code: sessionApprovalCodeSchema,
});

export async function POST(request: Request) {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = requestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_approval_code" },
      { status: 400 },
    );
  }
  try {
    const result = await cloudRequest<{
      approved: true;
      requestId: string;
    }>(
      "/v1/internal/cloud/session-requests/approve",
      authorization.identity,
      { extraBody: { approvalCode: parsed.data.code } },
    );
    return NextResponse.json(result);
  } catch (error) {
    return cloudRouteError(error);
  }
}
