import { describe, expect, it } from "vitest";
import {
  billingAppUrl,
  checkoutIntegrationIdentifier,
  managedBillingEnabled,
  planForStripeSubscriptionStatus,
} from "../apps/web/src/lib/billing-policy.js";

describe("billing security policy", () => {
  it("grants Pro only for Stripe statuses with current subscription authority", () => {
    expect(planForStripeSubscriptionStatus("active")).toBe("pro");
    expect(planForStripeSubscriptionStatus("trialing")).toBe("pro");
    for (const status of ["incomplete", "incomplete_expired", "past_due", "canceled", "unpaid", "paused"]) {
      expect(planForStripeSubscriptionStatus(status)).toBe("free");
    }
  });

  it("uses only a configured, origin-only HTTPS billing return URL in production", () => {
    expect(billingAppUrl({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "https://odyshell.com/path" })).toBe("https://odyshell.com");
    expect(() => billingAppUrl({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://odyshell.com" })).toThrow("HTTPS");
    expect(() => billingAppUrl({ NEXT_PUBLIC_APP_URL: "https://user:secret@odyshell.com" })).toThrow("credentials");
    expect(() => billingAppUrl({})).toThrow("required");
  });

  it("enables managed billing only for explicit cloud deployments", () => {
    expect(managedBillingEnabled({
      ODYSHELL_DEPLOYMENT_MODE: "cloud",
      ODYSHELL_MANAGED_BILLING_ENABLED: "true",
    })).toBe(true);
    expect(managedBillingEnabled({
      ODYSHELL_DEPLOYMENT_MODE: "cloud",
      ODYSHELL_MANAGED_BILLING_ENABLED: "false",
    })).toBe(false);
    expect(managedBillingEnabled({
      ODYSHELL_DEPLOYMENT_MODE: "self-hosted",
      ODYSHELL_MANAGED_BILLING_ENABLED: "true",
    })).toBe(false);
    expect(managedBillingEnabled({})).toBe(false);
  });

  it("uses a stable Stripe integration identifier with eight opaque letters", () => {
    const identifier = checkoutIntegrationIdentifier("org-a:3:1234");
    expect(identifier).toMatch(/^odyshell_web_[a-z]{8}$/);
    expect(checkoutIntegrationIdentifier("org-a:3:1234")).toBe(identifier);
    expect(checkoutIntegrationIdentifier("org-a:3:1235")).not.toBe(identifier);
  });
});
