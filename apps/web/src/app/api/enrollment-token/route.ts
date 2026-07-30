import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { cloudRequest, CloudApiError } from "@/lib/cloud-api";
import { currentCloudIdentity } from "@/lib/clerk-identity";

export async function POST() {
  const authorization = await auth();
  if (!authorization.userId) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  if (!authorization.has({ role: "org:admin" })) {
    return NextResponse.json({ error: "organization_admin_required" }, { status: 403 });
  }
  const identity = await currentCloudIdentity();
  if (!identity) return NextResponse.json({ error: "organization_required" }, { status: 403 });
  try {
    const token = await cloudRequest<{ token: string; expiresAt: string }>(
      "/v1/internal/cloud/enrollment-token",
      identity,
    );
    return NextResponse.json(token, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
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
