import { auth } from "@clerk/nextjs/server";
import { cache } from "react";
import { redirect } from "next/navigation";
import {
  currentCloudIdentity,
  organizationMembers,
} from "@/lib/clerk-identity";
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
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=%2Fdashboard");

  const identity = await currentCloudIdentity();
  if (!identity) return { status: "organization-required" };

  try {
    const [context, members] = await Promise.all([
      cloudRequest<Omit<CloudContext, "members">>(
        "/v1/internal/cloud/context",
        identity,
      ),
      organizationMembers(identity.organization.externalId),
    ]);
    return { status: "ready", context: { ...context, members } };
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
