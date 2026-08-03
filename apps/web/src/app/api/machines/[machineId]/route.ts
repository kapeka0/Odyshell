import { capabilitySchema } from "@odyshell/protocol";
import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";

const machineIdSchema = z.string().uuid();
const updateMachineSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(280),
  capabilities: z.array(capabilitySchema).max(32),
}).strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ machineId: string }> },
) {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  const machineId = machineIdSchema.safeParse((await params).machineId);
  const input = updateMachineSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!machineId.success || !input.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const result = await cloudRequest<{
      id: string;
      name: string;
      description: string | null;
      capabilities: z.infer<typeof updateMachineSchema>["capabilities"];
      availableCapabilities: z.infer<typeof updateMachineSchema>["capabilities"];
    }>("/v1/internal/cloud/machines/update", authorization.identity, {
      extraBody: { machineId: machineId.data, ...input.data },
    });
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return cloudRouteError(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ machineId: string }> },
) {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = machineIdSchema.safeParse((await params).machineId);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_machine_id" }, { status: 400 });
  }
  try {
    const result = await cloudRequest<{
      id: string;
      name: string;
      status: "revoked";
    }>("/v1/internal/cloud/machines/revoke", authorization.identity, {
      extraBody: { machineId: parsed.data },
    });
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return cloudRouteError(error);
  }
}
