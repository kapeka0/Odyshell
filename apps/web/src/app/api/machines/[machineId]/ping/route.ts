import { NextResponse } from "next/server";
import { z } from "zod";
import { controlRequest } from "@/lib/control-api";
import {
  controlRouteError,
  requireControlRouteIdentity,
} from "@/lib/control-route";

const machineIdSchema = z.string().uuid();

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ machineId: string }> },
) {
  const authorization = await requireControlRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = machineIdSchema.safeParse((await params).machineId);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_machine_id" }, { status: 400 });
  }
  try {
    const result = await controlRequest<{
      reply: "pong";
      machineId: string;
      latencyMs: number;
    }>("/v1/internal/control/machines/ping", authorization.identity, {
      extraBody: { machineId: parsed.data },
    });
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return controlRouteError(error);
  }
}
