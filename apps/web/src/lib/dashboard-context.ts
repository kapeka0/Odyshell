import { cache } from "react";
import { redirect } from "next/navigation";
import {
  currentControlIdentity,
  currentHumanIdentity,
  currentHumanSession,
  organizationMembers,
} from "@/lib/identity";
import {
  ControlApiError,
  controlRequest,
  type ControlContext,
} from "@/lib/control-api";

export type DashboardState =
  | { status: "ready"; context: ControlContext }
  | { status: "organization-required" }
  | { status: "unavailable"; message: string };

export const dashboardState = cache(async (): Promise<DashboardState> => {
  const session = await currentHumanSession();
  if (!session) redirect("/sign-in?redirect_url=%2Fdashboard");

  const [identity, humanIdentity] = await Promise.all([
    currentControlIdentity(),
    currentHumanIdentity(),
  ]);
  if (!identity || !humanIdentity) return { status: "organization-required" };

  try {
    const [context, members] = await Promise.all([
      controlRequest<Omit<ControlContext, "members" | "currentMemberRole">>(
        "/v1/internal/control/context",
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
        reason instanceof ControlApiError
          ? reason.code
          : "Odyshell server is unavailable",
    };
  }
});
