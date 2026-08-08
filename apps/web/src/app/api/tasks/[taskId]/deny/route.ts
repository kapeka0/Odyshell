import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest, type CloudTask } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";

const taskIdSchema = z.string().uuid();

export async function POST(
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = taskIdSchema.safeParse((await context.params).taskId);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_task_id" }, { status: 400 });
  }
  try {
    const result = await cloudRequest<{ task: CloudTask; delivery: "sent" }>(
      `/v1/internal/tasks/${parsed.data}/deny`,
      authorization.identity,
    );
    return NextResponse.json(result);
  } catch (error) {
    return cloudRouteError(error);
  }
}
