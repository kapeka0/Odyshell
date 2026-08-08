import { NextResponse } from "next/server";
import { CloudApiError, type CloudIdentity } from "@/lib/cloud-api";
import { currentHumanIdentity, currentHumanSession } from "@/lib/identity";
import { canAdministerOrganization } from "@/lib/identity-permissions";

type CloudRouteIdentity =
  | { identity: CloudIdentity; response?: never }
  | { identity?: never; response: NextResponse };

export async function requireCloudRouteIdentity(): Promise<CloudRouteIdentity> {
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
      userName: humanIdentity.user.name,
      role: humanIdentity.role,
      organization: {
        externalId: humanIdentity.organization.id,
        slug: humanIdentity.organization.slug,
        name: humanIdentity.organization.name,
      },
    },
  };
}

export async function requireCloudAdminRouteIdentity(): Promise<CloudRouteIdentity> {
  const authorization = await requireCloudRouteIdentity();
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

export function cloudRouteError(error: unknown): NextResponse {
  if (error instanceof CloudApiError) {
    return NextResponse.json(
      { error: error.code, details: error.details },
      { status: error.status },
    );
  }
  throw error;
}
