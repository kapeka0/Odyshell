import { NextResponse } from "next/server";
import { controlRequest, type ControlSession } from "@/lib/control-api";
import {
  controlRouteError,
  requireControlRouteIdentity,
} from "@/lib/control-route";

export async function GET() {
  const authorization = await requireControlRouteIdentity();
  if (authorization.response) return authorization.response;
  try {
    const result = await controlRequest<{ data: ControlSession[] }>(
      "/v1/internal/sessions/query",
      authorization.identity,
    );
    return NextResponse.json(result);
  } catch (error) {
    return controlRouteError(error);
  }
}
