import { NextResponse } from "next/server";
import {
  billingAppUrl,
  checkoutIntegrationIdentifier,
  managedBillingEnabled,
} from "@/lib/billing-policy";
import { cloudRequest, type CloudContext } from "@/lib/cloud-api";
import { requireCloudOwnerRouteIdentity } from "@/lib/cloud-route";
import { organizationMembers } from "@/lib/identity";
import { stripeClient, stripeProPriceId } from "@/lib/stripe";

export async function POST() {
  if (!managedBillingEnabled(process.env)) {
    return NextResponse.json({ error: "managed_billing_unavailable" }, { status: 404 });
  }
  const authorization = await requireCloudOwnerRouteIdentity();
  if (authorization.response) return authorization.response;
  const [context, members] = await Promise.all([
    cloudRequest<Omit<CloudContext, "members" | "currentMemberRole">>(
      "/v1/internal/cloud/context",
      authorization.identity,
    ),
    organizationMembers(),
  ]);
  if (members.length < 1 || members.length > 20) {
    return NextResponse.json({ error: "pro_member_limit" }, { status: 409 });
  }
  if (context.organization.stripeSubscriptionId || context.plan.id === "pro") {
    return NextResponse.json({ error: "pro_subscription_exists" }, { status: 409 });
  }
  const stripe = stripeClient();
  const organizationId = authorization.identity.organization.externalId;
  const checkoutWindow = Math.floor(Date.now() / 3_600_000);
  const customerId = context.organization.stripeCustomerId ?? (await stripe.customers.create({
    name: authorization.identity.organization.name,
    metadata: { odyshellOrganizationId: organizationId },
  }, { idempotencyKey: `odyshell-customer-${organizationId}` })).id;
  const appUrl = billingAppUrl(process.env);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    integration_identifier: checkoutIntegrationIdentifier(
      `${organizationId}:${members.length}:${checkoutWindow}`,
    ),
    customer: customerId,
    client_reference_id: organizationId,
    line_items: [{ price: stripeProPriceId(), quantity: members.length }],
    metadata: { odyshellOrganizationId: organizationId },
    subscription_data: { metadata: { odyshellOrganizationId: organizationId } },
    success_url: `${appUrl}/dashboard/settings?billing=success`,
    cancel_url: `${appUrl}/dashboard/settings?billing=cancelled`,
  }, {
    idempotencyKey: `odyshell-pro-checkout-${organizationId}-${members.length}-${checkoutWindow}`,
  });
  if (!session.url) return NextResponse.json({ error: "checkout_unavailable" }, { status: 502 });
  return NextResponse.json({ url: session.url });
}
