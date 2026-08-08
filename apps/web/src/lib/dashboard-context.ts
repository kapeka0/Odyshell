import { cache } from "react";
import { redirect } from "next/navigation";
import {
  currentCloudIdentity,
  currentHumanIdentity,
  currentHumanSession,
  organizationMembers,
} from "@/lib/identity";
import {
  CloudApiError,
  cloudRequest,
  type CloudContext,
} from "@/lib/cloud-api";

export type DashboardState =
  | { status: "ready"; context: CloudContext }
  | { status: "organization-required" }
  | { status: "unavailable"; message: string };

export const dashboardState = cache(async (): Promise<DashboardState> => {
  const session = await currentHumanSession();
  if (!session) redirect("/sign-in?redirect_url=%2Fdashboard");

  const [identity, humanIdentity] = await Promise.all([
    currentCloudIdentity(),
    currentHumanIdentity(),
  ]);
  if (!identity || !humanIdentity) return { status: "organization-required" };

  try {
    const [context, members] = await Promise.all([
      cloudRequest<Omit<CloudContext, "members" | "currentMemberRole">>(
        "/v1/internal/cloud/context",
        identity,
      ),
      organizationMembers(),
    ]);
    return {
      status: "ready",
      context: {
        ...context,
        members,
        currentMemberRole: humanIdentity.role,
      },
    };
  } catch (reason) {
    return {
      status: "unavailable",
      message:
        reason instanceof CloudApiError
          ? reason.code
          : "Odyshell server is unavailable",
    };
  }
});
