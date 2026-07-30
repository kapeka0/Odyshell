import { NextResponse } from "next/server";
import { cloudRequest } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";

export async function POST() {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  try {
    const token = await cloudRequest<{ token: string; expiresAt: string }>(
      "/v1/internal/cloud/enrollment-token",
      authorization.identity,
    );
    return NextResponse.json(token, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return cloudRouteError(error);
  }
}
