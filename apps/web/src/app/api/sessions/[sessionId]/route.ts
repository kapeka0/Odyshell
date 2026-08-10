import { NextResponse } from "next/server";
import { controlRequest, type ControlSessionTimeline } from "@/lib/control-api";
import { controlRouteError, requireControlRouteIdentity } from "@/lib/control-route";

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const authorization = await requireControlRouteIdentity();
  if (authorization.response) return authorization.response;
  const { sessionId } = await params;
  try {
    const timeline = await controlRequest<ControlSessionTimeline>(
      `/v1/internal/sessions/${encodeURIComponent(sessionId)}/timeline`,
      authorization.identity,
    );
    return NextResponse.json(timeline);
  } catch (error) {
    return controlRouteError(error);
  }
}
