import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest, type CloudContext } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudAdminRouteIdentity,
} from "@/lib/cloud-route";
import { getAuth } from "@/lib/auth";

const settingsSchema = z
  .object({
    section: z.literal("details"),
    name: z.string().trim().min(1).max(96),
    avatarSeed: z.string().trim().min(1).max(128),
  })
  .strict();

export async function PUT(request: Request) {
  const authorization = await requireCloudAdminRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = settingsSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const result = await cloudRequest<{
      organization: CloudContext["organization"];
    }>(
      "/v1/internal/cloud/organization/settings/update",
      authorization.identity,
      { extraBody: parsed.data },
    );
    await getAuth().api.updateOrganization({
      headers: await headers(),
      body: {
        organizationId: authorization.identity.organization.externalId,
        data: { name: parsed.data.name },
      },
    });
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return cloudRouteError(error);
  }
}
