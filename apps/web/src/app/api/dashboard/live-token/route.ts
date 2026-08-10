import { NextResponse } from "next/server";
import { controlRequest } from "@/lib/control-api";
import {
  controlRouteError,
  requireControlRouteIdentity,
} from "@/lib/control-route";

export async function POST() {
  const authorization = await requireControlRouteIdentity();
  if (authorization.response) return authorization.response;
  try {
    const result = await controlRequest<{
      token: string;
      expiresAt: string;
    }>("/v1/internal/control/live-token", authorization.identity);
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return controlRouteError(error);
  }
}
