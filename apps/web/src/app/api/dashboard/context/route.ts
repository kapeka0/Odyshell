import { auth } from "@clerk/nextjs/server";
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
      cloudRequest<Omit<CloudContext, "members" | "currentMemberRole">>(
        "/v1/internal/cloud/context",
        authorization.identity,
      ),
      organizationMembers(authorization.identity.organization.externalId),
    ]);
    const { orgRole } = await auth();
    return NextResponse.json(
      {
        status: "ready",
        context: {
          ...context,
          members,
          currentMemberRole: orgRole === "org:admin" ? "admin" : "member",
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return cloudRouteError(error);
  }
}
