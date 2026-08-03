import { NextResponse } from "next/server";
import { cloudRequest } from "@/lib/cloud-api";
import { cloudRouteError, requireCloudRouteIdentity } from "@/lib/cloud-route";

export async function POST(request: Request) {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const result = await cloudRequest<Record<string, unknown>>(
      "/v1/internal/cloud/sessions/create",
      authorization.identity,
      { extraBody: body },
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return cloudRouteError(error);
  }
}
