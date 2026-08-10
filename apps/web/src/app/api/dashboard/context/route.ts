import { NextResponse } from "next/server";
import { controlRequest, type ControlContext } from "@/lib/control-api";
import {
  controlRouteError,
  requireControlRouteIdentity,
} from "@/lib/control-route";
import { currentHumanIdentity, organizationMembers } from "@/lib/identity";

export async function GET() {
  const authorization = await requireControlRouteIdentity();
  if (authorization.response) return authorization.response;
  try {
    const [context, members] = await Promise.all([
      controlRequest<Omit<ControlContext, "members" | "currentMemberRole">>(
        "/v1/internal/control/context",
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
    return controlRouteError(error);
  }
}
