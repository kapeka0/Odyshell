import { NextResponse } from "next/server";
import { ControlApiError, type ControlIdentity } from "@/lib/control-api";
import { currentHumanIdentity, currentHumanSession } from "@/lib/identity";
import { canAdministerOrganization } from "@/lib/identity-permissions";

type ControlRouteIdentity =
  | { identity: ControlIdentity; response?: never }
  | { identity?: never; response: NextResponse };

export async function requireControlRouteIdentity(): Promise<ControlRouteIdentity> {
  const session = await currentHumanSession();
  if (!session) {
    return {
      response: NextResponse.json(
        { error: "not_authenticated" },
        { status: 401 },
      ),
    };
  }
  const humanIdentity = await currentHumanIdentity();
  if (!humanIdentity) {
    return {
      response: NextResponse.json(
        { error: "organization_required" },
        { status: 403 },
      ),
    };
  }
  return {
    identity: {
      userId: humanIdentity.user.id,
      role: humanIdentity.role,
      organization: {
        externalId: humanIdentity.organization.id,
        slug: humanIdentity.organization.slug,
        name: humanIdentity.organization.name,
      },
    },
  };
}

export async function requireControlAdminRouteIdentity(): Promise<ControlRouteIdentity> {
  const authorization = await requireControlRouteIdentity();
  if (authorization.response) return authorization;
  const humanIdentity = await currentHumanIdentity();
  if (!humanIdentity || !canAdministerOrganization(humanIdentity.role)) {
    return {
      response: NextResponse.json(
        { error: "organization_admin_required" },
        { status: 403 },
      ),
    };
  }
  return authorization;
}

export async function requireControlOwnerRouteIdentity(): Promise<ControlRouteIdentity> {
  const authorization = await requireControlRouteIdentity();
  if (authorization.response) return authorization;
  const humanIdentity = await currentHumanIdentity();
  if (!humanIdentity || humanIdentity.role !== "owner") {
    return {
      response: NextResponse.json({ error: "organization_owner_required" }, { status: 403 }),
    };
  }
  return authorization;
}

export function controlRouteError(error: unknown): NextResponse {
  if (error instanceof ControlApiError) {
    return NextResponse.json(
      { error: error.code, details: error.details },
      { status: error.status },
    );
  }
  throw error;
}
