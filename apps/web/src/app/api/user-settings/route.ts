import { NextResponse } from "next/server";
import { z } from "zod";
import { controlRequest } from "@/lib/control-api";
import {
  controlRouteError,
  requireControlRouteIdentity,
} from "@/lib/control-route";

const settingsSchema = z.object({
  timeZone: z.string().trim().min(1).max(128).refine(
    (timeZone) => {
      if (timeZone === "System") return true;
      try {
        new Intl.DateTimeFormat("en-US", { timeZone }).format();
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid time zone" },
  ),
}).strict();

export async function PUT(request: Request) {
  const authorization = await requireControlRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = settingsSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const result = await controlRequest<{ timeZone: string }>(
      "/v1/internal/control/user-settings/update",
      authorization.identity,
      { extraBody: parsed.data },
    );
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return controlRouteError(error);
  }
}
