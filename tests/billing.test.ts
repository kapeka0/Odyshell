import { describe, expect, it } from "vitest";
import {
  billingAppUrl,
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
    expect(managedBillingEnabled({ ODYSHELL_DEPLOYMENT_MODE: "cloud" })).toBe(true);
    expect(managedBillingEnabled({ ODYSHELL_DEPLOYMENT_MODE: "self-hosted" })).toBe(false);
    expect(managedBillingEnabled({})).toBe(false);
  });
});
