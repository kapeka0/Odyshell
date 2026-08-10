import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { controlRequest, type ControlContext } from "@/lib/control-api";
import {
  controlRouteError,
  requireControlAdminRouteIdentity,
} from "@/lib/control-route";
import { getAuth } from "@/lib/auth";

const settingsSchema = z
  .object({
    section: z.literal("details"),
    name: z.string().trim().min(1).max(96),
    avatarSeed: z.string().trim().min(1).max(128),
  })
  .strict();

export async function PUT(request: Request) {
  const authorization = await requireControlAdminRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = settingsSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const result = await controlRequest<{
      organization: ControlContext["organization"];
    }>(
      "/v1/internal/control/organization/settings/update",
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
    return controlRouteError(error);
  }
}
