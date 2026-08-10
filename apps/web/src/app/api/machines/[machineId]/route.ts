import { NextResponse } from "next/server";
import { z } from "zod";
import { controlRequest } from "@/lib/control-api";
import {
  controlRouteError,
  requireControlRouteIdentity,
} from "@/lib/control-route";

const machineIdSchema = z.string().uuid();
const updateMachineSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(280),
}).strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ machineId: string }> },
) {
  const authorization = await requireControlRouteIdentity();
  if (authorization.response) return authorization.response;
  const machineId = machineIdSchema.safeParse((await params).machineId);
  const input = updateMachineSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!machineId.success || !input.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const result = await controlRequest<{
      id: string;
      name: string;
      description: string | null;
    }>("/v1/internal/control/machines/update", authorization.identity, {
      extraBody: { machineId: machineId.data, ...input.data },
    });
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return controlRouteError(error);
  }
}

export async function DELETE(
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
      id: string;
      name: string;
      status: "revoked";
    }>("/v1/internal/control/machines/revoke", authorization.identity, {
      extraBody: { machineId: parsed.data },
    });
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return controlRouteError(error);
  }
}
