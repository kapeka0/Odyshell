import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { CloudApiError, type CloudIdentity } from "@/lib/cloud-api";
import { cloudIdentityFor } from "@/lib/clerk-identity";
import { cloudRouteIdentityDecision } from "@/lib/cloud-route-policy";

type CloudRouteIdentity =
  | { identity: CloudIdentity; response?: never }
  | { identity?: never; response: NextResponse };

export async function requireCloudRouteIdentity(): Promise<CloudRouteIdentity> {
  const { userId, orgId } = await auth();
  const decision = cloudRouteIdentityDecision(userId, orgId);
  if (decision === "not_authenticated") {
    return {
      response: NextResponse.json(
        { error: "not_authenticated" },
        { status: 401 },
      ),
    };
  }
  if (decision === "organization_required") {
    return {
      response: NextResponse.json(
        { error: "organization_required" },
        { status: 403 },
      ),
    };
  }
  if (!userId || !orgId) throw new Error("Invalid cloud route identity state");
  return { identity: await cloudIdentityFor(userId, orgId) };
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
