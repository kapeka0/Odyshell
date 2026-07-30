/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
import {
  ArrowRightIcon,
  CheckIcon,
  LockKeyholeIcon,
} from "lucide-react";
import Link from "next/link";
import { ConnectionRoute } from "@/components/connection-route";
import { ProductPreview } from "@/components/product-preview";
import { Reveal } from "@/components/reveal";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const boundaries = [
  ["Connection", "The machine connects outbound. No inbound port is opened."],
  ["Identity", "Clients and agents receive separate, revocable identities."],
  ["Authority", "The server and local Client both enforce capability limits."],
  ["Privacy", "Audit events describe control actions without recording secrets."],
] as const;

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content" tabIndex={-1}>
        <section className="page-shell grid min-h-[calc(100svh-5rem)] gap-8 py-8 lg:grid-cols-[0.92fr_1.08fr] lg:items-stretch lg:py-10">
          <Reveal className="flex min-w-0 flex-col justify-center py-10 lg:py-16">
            <Badge variant="outline" className="mb-8 w-fit">
              Infrastructure for AI agents
            </Badge>
            <h1 className="display-balance max-w-[10ch] text-[clamp(3.4rem,7vw,6.8rem)] leading-[0.9] font-semibold tracking-[-0.065em]">
              Private machines, ready for agents.
            </h1>
            <p className="body-pretty mt-8 max-w-[38rem] text-lg leading-8 text-muted-foreground md:text-xl">
              Let an AI agent use a real machine without giving it SSH credentials,
              network access or a permanent key.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link
                className={cn(buttonVariants({ size: "lg" }), "whitespace-nowrap")}
                href="/sign-up"
              >
                Create a workspace
                <ArrowRightIcon data-icon="inline-end" />
              </Link>
              <Link
                className={cn(
                  buttonVariants({ variant: "outline", size: "lg" }),
                  "whitespace-nowrap",
                )}
                href="/#how-it-works"
              >
                See how it works
              </Link>
            </div>
            <p className="mt-6 font-mono text-xs text-muted-foreground">
              Linux · macOS · Windows · outbound only
            </p>
          </Reveal>

          <Reveal delay={0.08} className="min-h-[34rem] min-w-0">
            <ProductPreview />
          </Reveal>
        </section>

        <section className="page-shell pb-8 md:pb-16">
          <Reveal className="overflow-hidden rounded-[2.5rem] bg-[var(--color-graphite)] text-[var(--color-graphite-ink)]">
            <div className="grid gap-12 px-6 py-14 md:px-10 md:py-20 lg:grid-cols-[0.78fr_1.22fr] lg:items-center lg:px-16">
              <div>
                <p className="font-mono text-xs text-white/55">ONE SAFE ROUTE</p>
                <h2 className="display-balance mt-5 max-w-[12ch] text-4xl leading-[1.02] font-semibold tracking-[-0.045em] md:text-6xl">
                  Give agents access. Keep the network private.
                </h2>
                <p className="mt-6 max-w-md leading-7 text-white/62">
                  Odyshell sits between the agent and the machine. It verifies identity,
                  scope and time before forwarding a structured operation.
                </p>
              </div>
              <ConnectionRoute />
            </div>
          </Reveal>
        </section>

        <section id="how-it-works" className="page-shell grid gap-12 py-20 md:py-28 lg:grid-cols-[0.72fr_1.28fr]">
          <div>
            <p className="font-mono text-xs text-muted-foreground">HOW IT WORKS</p>
            <h2 className="display-balance mt-5 max-w-[12ch] text-4xl leading-[1.05] font-semibold tracking-[-0.04em] md:text-5xl">
              Three steps from private to agent-ready.
            </h2>
          </div>
          <ol className="border-t">
            {[
              ["01", "Connect the machine", "Run ods up once. The lightweight Client keeps an authenticated outbound connection open."],
              ["02", "Grant temporary access", "Choose the machine, allowed operations and expiry for one agent credential."],
              ["03", "Let the agent work", "The SDK or MCP sends structured operations. Odyshell checks and records each control decision."],
            ].map(([number, title, description]) => (
              <li
                key={number}
                className="grid gap-3 border-b py-7 sm:grid-cols-[3rem_minmax(0,1fr)]"
              >
                <span className="font-mono text-xs text-muted-foreground">{number}</span>
                <div>
                  <h3 className="text-xl font-semibold">{title}</h3>
                  <p className="mt-2 max-w-2xl leading-7 text-muted-foreground">
                    {description}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-y bg-muted/35">
          <div className="page-shell py-20 md:py-28">
            <div className="grid gap-10 lg:grid-cols-[0.7fr_1.3fr]">
              <div>
                <LockKeyholeIcon aria-hidden="true" className="text-muted-foreground" />
                <h2 className="display-balance mt-6 max-w-[12ch] text-4xl leading-[1.05] font-semibold tracking-[-0.04em] md:text-5xl">
                  Safety outside the model.
                </h2>
                <p className="mt-5 max-w-md leading-7 text-muted-foreground">
                  Prompts can request an action. Odyshell decides whether it may run.
                </p>
              </div>
              <div className="border-t">
                {boundaries.map(([title, description]) => (
                  <div
                    key={title}
                    className="grid gap-2 border-b py-5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-6"
                  >
                    <p className="font-medium">{title}</p>
                    <p className="leading-6 text-muted-foreground">{description}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="plans" className="page-shell grid gap-12 py-20 md:py-28 lg:grid-cols-[0.72fr_1.28fr]">
          <div>
            <p className="font-mono text-xs text-muted-foreground">START SMALL</p>
            <h2 className="display-balance mt-5 max-w-[11ch] text-4xl leading-[1.05] font-semibold tracking-[-0.04em] md:text-5xl">
              Prove the route for free.
            </h2>
            <p className="mt-5 max-w-md leading-7 text-muted-foreground">
              The MVP includes the complete operation model. Plans limit capacity, not
              security.
            </p>
          </div>
          <div className="rounded-2xl border bg-card p-6 md:p-8">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-2xl font-semibold">Free</p>
                <p className="mt-2 text-muted-foreground">For testing the complete workflow.</p>
              </div>
              <p className="text-4xl font-semibold tracking-tight">$0</p>
            </div>
            <ul className="mt-8 grid gap-3 border-t pt-6 sm:grid-cols-2">
              {["2 machines", "1 workspace", "3 active agent credentials", "All operation capabilities"].map((item) => (
                <li key={item} className="flex items-center gap-3 text-sm">
                  <CheckIcon aria-hidden="true" className="text-[var(--color-success)]" />
                  {item}
                </li>
              ))}
            </ul>
            <Link
              className={cn(buttonVariants({ size: "lg" }), "mt-8 w-full whitespace-nowrap sm:w-auto")}
              href="/sign-up"
            >
              Create a workspace
            </Link>
          </div>
        </section>
      </main>

      <footer className="page-shell pb-8">
        <div className="rounded-2xl border px-6 py-8 md:px-8">
          <p className="display-balance max-w-[24ch] text-3xl leading-tight font-semibold tracking-[-0.03em]">
            A safer route from agents to real machines.
          </p>
          <div className="mt-12 flex flex-col gap-4 border-t pt-5 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span className="font-semibold text-foreground">Odyshell</span>
            <div className="flex flex-wrap gap-5">
              <Link className="whitespace-nowrap hover:text-foreground" href="/#how-it-works">
                How it works
              </Link>
              <Link className="whitespace-nowrap hover:text-foreground" href="/dashboard">
                Dashboard
              </Link>
              <Link className="whitespace-nowrap hover:text-foreground" href="/docs">
                Docs
              </Link>
              <a
                className="whitespace-nowrap hover:text-foreground"
                href="https://github.com/kapeka0/odyshell"
              >
                GitHub
              </a>
            </div>
            <span>© 2026 Odyshell</span>
          </div>
        </div>
      </footer>
    </>
  );
}
