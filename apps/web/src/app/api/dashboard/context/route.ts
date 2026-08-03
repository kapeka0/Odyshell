import { NextResponse } from "next/server";
import { cloudRequest, type CloudContext } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";
import { organizationMembers } from "@/lib/clerk-identity";

export async function GET() {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  try {
    const [context, members] = await Promise.all([
      cloudRequest<Omit<CloudContext, "members">>(
        "/v1/internal/cloud/context",
        authorization.identity,
      ),
      organizationMembers(authorization.identity.organization.externalId),
    ]);
    return NextResponse.json(
      { status: "ready", context: { ...context, members } },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return cloudRouteError(error);
  }
}
