import { NextResponse } from "next/server";
import { cloudRequest, type CloudTask } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";

export async function GET() {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  try {
    const result = await cloudRequest<{ data: CloudTask[] }>(
      "/v1/internal/tasks/query",
      authorization.identity,
    );
    return NextResponse.json(result);
  } catch (error) {
    return cloudRouteError(error);
  }
}
