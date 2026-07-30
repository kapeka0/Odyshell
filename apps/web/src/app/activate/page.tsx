import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { DeviceActivation } from "@/components/device-activation";
import { SiteHeader } from "@/components/site-header";

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
    <>
      <SiteHeader />
      <main className="page-shell grid min-h-[calc(100svh-4rem)] place-items-center py-12">
        <div className="grid w-full justify-items-center gap-7">
          <div className="max-w-xl text-center">
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-primary">Browser approval</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight">Connect the CLI to your workspace</h1>
            <p className="mt-4 leading-7 text-muted-foreground">
              You are approving a human CLI credential, not an agent session. Agent access remains separately scoped and expiring.
            </p>
          </div>
          <DeviceActivation initialCode={code} />
        </div>
      </main>
    </>
  );
}
