import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest, type CloudEventSinkState } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudAdminRouteIdentity,
} from "@/lib/cloud-route";

const configurationSchema = z.object({
  endpoint: z.string().url().max(2_048),
  detailLevel: z.enum(["privacy-minimal", "operational", "diagnostic"]),
  signingSecret: z.string().min(32).max(256),
}).strict();

export async function GET() {
  const authorization = await requireCloudAdminRouteIdentity();
  if (authorization.response) return authorization.response;
  try {
    const result = await cloudRequest<CloudEventSinkState>(
      "/v1/internal/cloud/event-sink",
      authorization.identity,
    );
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return cloudRouteError(error);
  }
}

export async function PUT(request: Request) {
  const authorization = await requireCloudAdminRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = configurationSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const result = await cloudRequest<{ data: CloudEventSinkState["data"] }>(
      "/v1/internal/cloud/event-sink/configure",
      authorization.identity,
      { extraBody: parsed.data },
    );
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return cloudRouteError(error);
  }
}

export async function DELETE() {
  const authorization = await requireCloudAdminRouteIdentity();
  if (authorization.response) return authorization.response;
  try {
    const result = await cloudRequest<{ deleted: true }>(
      "/v1/internal/cloud/event-sink/delete",
      authorization.identity,
    );
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return cloudRouteError(error);
  }
}
