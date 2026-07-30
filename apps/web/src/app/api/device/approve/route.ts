import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { cloudRequest, CloudApiError } from "@/lib/cloud-api";
import { currentCloudIdentity } from "@/lib/clerk-identity";

const requestSchema = z.object({
  code: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase().replaceAll("-", ""))
    .pipe(z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/, "Invalid device code")),
});

export async function POST(request: Request) {
  const authorization = await auth();
  if (!authorization.userId) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  if (!authorization.has({ role: "org:admin" })) {
    return NextResponse.json({ error: "organization_admin_required" }, { status: 403 });
  }
  const identity = await currentCloudIdentity();
  if (!identity) return NextResponse.json({ error: "organization_required" }, { status: 403 });
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
      identity,
      { extraBody: { userCode: parsed.data.code } },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CloudApiError) {
      return NextResponse.json(
        { error: error.code, details: error.details },
        { status: error.status },
      );
    }
    throw error;
  }
}
