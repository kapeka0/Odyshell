import { NextResponse } from "next/server";
import { cloudRequest, type CloudContext } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";

export async function GET() {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  try {
    const context = await cloudRequest<CloudContext>(
      "/v1/internal/cloud/context",
      authorization.identity,
    );
    return NextResponse.json(
      { status: "ready", context },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return cloudRouteError(error);
  }
}
