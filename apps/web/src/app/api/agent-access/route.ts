import { agentTokenRequestSchema } from "@odyshell/protocol";
import { NextResponse } from "next/server";
import { cloudRequest } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";

export async function POST(request: Request) {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = agentTokenRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_agent_access", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  try {
    const access = await cloudRequest<{
      id: string;
      name: string;
      token: string;
      machineIds: string[];
      capabilities: string[];
      expiresAt: string;
    }>("/v1/internal/cloud/agent-access", authorization.identity, {
      extraBody: parsed.data,
    });
    return NextResponse.json(access, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return cloudRouteError(error);
  }
}
