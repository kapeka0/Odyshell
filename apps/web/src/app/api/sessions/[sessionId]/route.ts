import { NextResponse } from "next/server";
import { cloudRequest, type CloudSessionTimeline } from "@/lib/cloud-api";
import { cloudRouteError, requireCloudRouteIdentity } from "@/lib/cloud-route";

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  const { sessionId } = await params;
  try {
    const timeline = await cloudRequest<CloudSessionTimeline>(
      `/v1/internal/sessions/${encodeURIComponent(sessionId)}/timeline`,
      authorization.identity,
    );
    return NextResponse.json(timeline);
  } catch (error) {
    return cloudRouteError(error);
  }
}
