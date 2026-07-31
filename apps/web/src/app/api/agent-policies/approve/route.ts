import { NextResponse } from "next/server";
import { z } from "zod";
import { agentPolicyCodeSchema } from "@/lib/agent-policy";
import { cloudRequest } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudAdminRouteIdentity,
} from "@/lib/cloud-route";

const requestSchema = z.object({ code: agentPolicyCodeSchema }).strict();

export async function POST(request: Request) {
  const authorization = await requireCloudAdminRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_policy_code" }, { status: 400 });
  }
  try {
    const result = await cloudRequest<{
      approved: true;
      policyId: string;
      version: number;
    }>(
      "/v1/internal/cloud/agent-policies/approve",
      authorization.identity,
      { extraBody: { approvalCode: parsed.data.code } },
    );
    return NextResponse.json(result);
  } catch (error) {
    return cloudRouteError(error);
  }
}
