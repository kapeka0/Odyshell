import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { ActivationShell } from "@/components/activation-shell";
import { DeviceActivation } from "@/components/device-activation";

export default async function ActivatePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const params = await searchParams;
  const code = typeof params.code === "string" ? params.code : "";
  const { userId } = await auth();
  if (!userId) {
    const destination = `/activate${code ? `?code=${encodeURIComponent(code)}` : ""}`;
    redirect(`/sign-in?redirect_url=${encodeURIComponent(destination)}`);
  }
  return (
    <ActivationShell
      title="Approve CLI access"
      description="Confirm the one-time code from ods. Your browser session is never shared with the CLI."
    >
      <DeviceActivation initialCode={code} />
    </ActivationShell>
  );
}
