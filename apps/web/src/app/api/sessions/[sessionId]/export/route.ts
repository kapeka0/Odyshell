import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";

const sessionIdSchema = z.string().uuid();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = sessionIdSchema.safeParse((await params).sessionId);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_session_id" }, { status: 400 });
  }
  try {
    const result = await cloudRequest<Record<string, unknown>>(
      "/v1/internal/cloud/sessions/export",
      authorization.identity,
      {
        extraBody: {
          sessionId: parsed.data,
          detailLevel: "privacy-minimal",
        },
      },
    );
    return new NextResponse(JSON.stringify(result, null, 2), {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="odyshell-session-${parsed.data}.json"`,
        "content-type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    return cloudRouteError(error);
  }
}
