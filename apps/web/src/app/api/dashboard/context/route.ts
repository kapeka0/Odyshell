import { NextResponse } from "next/server";
import { cloudRequest, type CloudContext } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";
import { currentHumanIdentity, organizationMembers } from "@/lib/identity";

export async function GET() {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  try {
    const [context, members] = await Promise.all([
      cloudRequest<Omit<CloudContext, "members" | "currentMemberRole">>(
        "/v1/internal/cloud/context",
        authorization.identity,
      ),
      organizationMembers(),
    ]);
    const humanIdentity = await currentHumanIdentity();
    if (!humanIdentity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return NextResponse.json(
      {
        status: "ready",
        context: {
          ...context,
          members,
          currentMemberRole: humanIdentity.role,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return cloudRouteError(error);
  }
}
