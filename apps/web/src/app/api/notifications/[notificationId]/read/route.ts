import { NextResponse } from "next/server";
import { z } from "zod";
import { controlRequest } from "@/lib/control-api";
import {
  controlRouteError,
  requireControlRouteIdentity,
} from "@/lib/control-route";

const notificationIdSchema = z.string().uuid();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ notificationId: string }> },
) {
  const authorization = await requireControlRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = notificationIdSchema.safeParse((await params).notificationId);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_notification_id" },
      { status: 400 },
    );
  }
  try {
    const body = (await request.json().catch(() => ({}))) as { read?: unknown };
    const read = typeof body.read === "boolean" ? body.read : true;
    const result = await controlRequest<{ read: boolean }>(
      "/v1/internal/control/notifications/read",
      authorization.identity,
      { extraBody: { notificationId: parsed.data, read } },
    );
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return controlRouteError(error);
  }
}
