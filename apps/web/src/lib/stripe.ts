import "server-only";

import Stripe from "stripe";

let client: Stripe | undefined;

export function stripeClient(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured");
  client ??= new Stripe(secretKey, { apiVersion: "2026-07-29.dahlia" });
  return client;
}

export function stripeProPriceId(): string {
  const priceId = process.env.STRIPE_PRO_PRICE_ID;
  if (!priceId || !/^price_[A-Za-z0-9]+$/u.test(priceId)) {
    throw new Error("STRIPE_PRO_PRICE_ID is not configured");
  }
  return priceId;
}

export function stripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !secret.startsWith("whsec_")) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  return secret;
}
