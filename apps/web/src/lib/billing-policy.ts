export function planForStripeSubscriptionStatus(status: string): "free" | "pro" {
  return status === "active" || status === "trialing" ? "pro" : "free";
}

export function managedBillingEnabled(environment: NodeJS.ProcessEnv): boolean {
  return environment.ODYSHELL_DEPLOYMENT_MODE === "cloud";
}

export function billingAppUrl(environment: NodeJS.ProcessEnv): string {
  const configured = environment.NEXT_PUBLIC_APP_URL ?? environment.BETTER_AUTH_URL;
  if (!configured) throw new Error("NEXT_PUBLIC_APP_URL or BETTER_AUTH_URL is required for billing");
  const url = new URL(configured);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Billing app URL must not contain credentials, query parameters, or fragments");
  }
  if (environment.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("Billing app URL must use HTTPS in production");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Billing app URL must use HTTP or HTTPS");
  return url.origin;
}
