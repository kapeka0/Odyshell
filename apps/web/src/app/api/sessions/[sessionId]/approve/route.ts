import { NextResponse } from "next/server";
import { z } from "zod";
import { controlRequest, type ControlSession } from "@/lib/control-api";
import {
  controlRouteError,
  requireControlRouteIdentity,
} from "@/lib/control-route";

const sessionIdSchema = z.string().uuid();

export async function POST(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authorization = await requireControlRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = sessionIdSchema.safeParse((await context.params).sessionId);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_session_id" }, { status: 400 });
  }
  try {
    const result = await controlRequest<{ session: ControlSession; delivery: "sent" | "pending" }>(
      `/v1/internal/sessions/${parsed.data}/approve`,
      authorization.identity,
    );
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return controlRouteError(error);
  }
}
