import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Docs",
  description: "Connect machines and grant temporary agent access with Odyshell.",
  alternates: { canonical: "/docs" },
};

const steps = [
  {
    number: "01",
    title: "Sign in",
    body: "Run ods login. Your browser approves the CLI for the selected workspace.",
    code: "ods login",
  },
  {
    number: "02",
    title: "Connect a machine",
    body: "Open Machines, choose Add and run the generated command on the target computer.",
    code: "ods up …",
  },
  {
    number: "03",
    title: "Create an agent",
    body: "Choose its machines, capabilities and expiry. Copy the generated login command once.",
    code: "ods login --agent-token …",
  },
] as const;

export default function DocsPage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content" tabIndex={-1}>
        <section className="page-shell grid gap-10 py-16 md:py-24 lg:grid-cols-[0.65fr_1.35fr]">
          <div>
            <Badge variant="outline">Documentation</Badge>
            <h1 className="mt-6 text-5xl font-semibold tracking-[-0.05em]">
              Start with Odyshell.
            </h1>
            <p className="mt-5 max-w-md leading-7 text-muted-foreground">
              Connect a private machine, grant temporary access and let an
              agent use structured operations without SSH.
            </p>
            <Link
              href="/dashboard"
              className={`${buttonVariants()} mt-8`}
            >
              Dashboard
            </Link>
          </div>

          <div className="border-t">
            {steps.map((step) => (
              <article
                key={step.number}
                className="grid gap-4 border-b py-8 sm:grid-cols-[3rem_minmax(0,1fr)]"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {step.number}
                </span>
                <div>
                  <h2 className="text-xl font-semibold">{step.title}</h2>
                  <p className="mt-2 max-w-2xl leading-7 text-muted-foreground">
                    {step.body}
                  </p>
                  <code className="mt-5 block overflow-x-auto rounded-lg border bg-muted/40 px-4 py-3 text-sm">
                    {step.code}
                  </code>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="border-y bg-muted/35">
          <div className="page-shell grid gap-10 py-16 md:grid-cols-2 md:py-20">
            <div>
              <p className="font-mono text-xs text-muted-foreground">MCP</p>
              <h2 className="mt-4 text-3xl font-semibold tracking-[-0.035em]">
                Give the agent tools.
              </h2>
              <p className="mt-4 max-w-md leading-7 text-muted-foreground">
                After agent login, launch the local MCP server from the agent
                configuration.
              </p>
            </div>
            <pre className="overflow-x-auto rounded-xl bg-foreground p-5 text-sm leading-6 text-background">
              <code>{`{
  "mcpServers": {
    "odyshell": {
      "command": "ods",
      "args": ["mcp"]
    }
  }
}`}</code>
            </pre>
          </div>
        </section>
      </main>
    </>
  );
}
