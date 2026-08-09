import { NextResponse } from "next/server";
import { billingAppUrl, managedBillingEnabled } from "@/lib/billing-policy";
import { cloudRequest, type CloudContext } from "@/lib/cloud-api";
import { requireCloudOwnerRouteIdentity } from "@/lib/cloud-route";
import { stripeClient } from "@/lib/stripe";

export async function POST() {
  if (!managedBillingEnabled(process.env)) {
    return NextResponse.json({ error: "managed_billing_unavailable" }, { status: 404 });
  }
  const authorization = await requireCloudOwnerRouteIdentity();
  if (authorization.response) return authorization.response;
  const context = await cloudRequest<Omit<CloudContext, "members" | "currentMemberRole">>(
    "/v1/internal/cloud/context",
    authorization.identity,
  );
  if (!context.organization.stripeCustomerId) {
    return NextResponse.json({ error: "billing_customer_not_found" }, { status: 404 });
  }
  const session = await stripeClient().billingPortal.sessions.create({
    customer: context.organization.stripeCustomerId,
    return_url: `${billingAppUrl(process.env)}/dashboard/settings`,
  });
  return NextResponse.json({ url: session.url });
}
