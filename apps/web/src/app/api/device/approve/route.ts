import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest } from "@/lib/cloud-api";
import {
  cloudRouteError,
  requireCloudRouteIdentity,
} from "@/lib/cloud-route";

const requestSchema = z.object({
  code: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase().replaceAll("-", ""))
    .pipe(z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/, "Invalid device code")),
});

export async function POST(request: Request) {
  const authorization = await requireCloudRouteIdentity();
  if (authorization.response) return authorization.response;
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_device_code", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  try {
    const result = await cloudRequest<{ approved: true }>(
      "/v1/internal/cloud/device/approve",
      authorization.identity,
      { extraBody: { userCode: parsed.data.code } },
    );
    return NextResponse.json(result);
  } catch (error) {
    return cloudRouteError(error);
  }
}
