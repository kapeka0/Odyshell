import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { managedBillingEnabled, planForStripeSubscriptionStatus } from "@/lib/billing-policy";
import { DEFAULT_CLOUD_SERVER_URL } from "@/lib/cloud-api";
import { stripeClient, stripeWebhookSecret } from "@/lib/stripe";

export async function POST(request: Request) {
  if (!managedBillingEnabled(process.env)) {
    return NextResponse.json({ error: "managed_billing_unavailable" }, { status: 404 });
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "stripe_signature_required" }, { status: 400 });
  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(await request.text(), signature, stripeWebhookSecret());
  } catch {
    return NextResponse.json({ error: "invalid_stripe_signature" }, { status: 400 });
  }
  if (!event.type.startsWith("customer.subscription.")) return NextResponse.json({ received: true });
  const subscription = event.data.object as Stripe.Subscription;
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  let organizationId = subscription.metadata.odyshellOrganizationId;
  if (!organizationId) {
    const customer = await stripeClient().customers.retrieve(customerId);
    if (!customer.deleted) organizationId = customer.metadata.odyshellOrganizationId;
  }
  if (!organizationId) return NextResponse.json({ error: "stripe_organization_missing" }, { status: 400 });
  const webKey = process.env.ODYSHELL_WEB_KEY;
  if (!webKey) return NextResponse.json({ error: "web_key_not_configured" }, { status: 503 });
  const serverUrl = process.env.ODYSHELL_SERVER_URL ?? process.env.NEXT_PUBLIC_ODYSHELL_SERVER_URL ?? DEFAULT_CLOUD_SERVER_URL;
  const response = await fetch(new URL("/v1/internal/cloud/billing/plan", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-odyshell-web-key": webKey },
    body: JSON.stringify({
      eventId: event.id,
      externalOrganizationId: organizationId,
      plan: planForStripeSubscriptionStatus(subscription.status),
      stripeCustomerId: customerId,
      stripeSubscriptionId: event.type === "customer.subscription.deleted" ? null : subscription.id,
    }),
    cache: "no-store",
  });
  if (!response.ok) return NextResponse.json({ error: "billing_sync_failed" }, { status: 502 });
  return NextResponse.json({ received: true });
}
