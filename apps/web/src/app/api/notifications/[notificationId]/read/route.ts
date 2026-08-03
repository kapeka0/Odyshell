import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";

const notificationIdSchema = z.string().uuid();

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ notificationId: string }> },
) {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = notificationIdSchema.safeParse((await params).notificationId);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_notification_id" },
      { status: 400 },
    );
  }
  try {
    const result = await cloudRequest<{ read: true }>(
      "/v1/internal/cloud/notifications/read",
      authorization.identity,
      { extraBody: { notificationId: parsed.data } },
    );
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return cloudRouteError(error);
  }
}
