import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest, type CloudContext } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudAdminRouteIdentity,
} from "@/lib/cloud-route";

const settingsSchema = z.object({
  name: z.string().trim().min(1).max(96),
  avatarSeed: z.string().trim().min(1).max(128),
  loggingLevel: z.enum(["privacy-minimal", "operational", "diagnostic"]),
}).strict();

export async function PUT(request: Request) {
  const authorization = await requireCloudAdminRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = settingsSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const result = await cloudRequest<{
      workspace: CloudContext["workspace"];
    }>(
      "/v1/internal/cloud/workspace/settings/update",
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
