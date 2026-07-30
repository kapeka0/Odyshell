import { auth } from "@clerk/nextjs/server";
import { cache } from "react";
import { redirect } from "next/navigation";
import { currentCloudIdentity } from "@/lib/clerk-identity";
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
    const context = await cloudRequest<CloudContext>(
      "/v1/internal/cloud/context",
      identity,
    );
    return { status: "ready", context };
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
