import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudAdminRouteIdentity,
} from "@/lib/cloud-route";
import { deviceCodeSchema } from "@/lib/device-activation";

const requestSchema = z.object({ code: deviceCodeSchema }).strict();

export async function POST(request: Request) {
  const authorization = await requireCloudAdminRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_device_code" }, { status: 400 });
  }
  try {
    const result = await cloudRequest<{ approved: true; agentId: string }>(
      "/v1/internal/cloud/agent-device/approve",
      authorization.identity,
      { extraBody: { userCode: parsed.data.code } },
    );
    return NextResponse.json(result);
  } catch (error) {
    return cloudRouteError(error);
  }
}
