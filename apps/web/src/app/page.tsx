import {
  ArrowRightIcon,
  CheckIcon,
  CloudIcon,
  EyeIcon,
  KeyRoundIcon,
  ShieldCheckIcon,
  TerminalIcon,
} from "lucide-react";
import { Manrope } from "next/font/google";
import Link from "next/link";
import { AgentCommandTrace } from "@/components/agent-command-trace";
import { ConnectionRoute } from "@/components/connection-route";
import { SiteHeader } from "@/components/site-header";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const marketingFont = Manrope({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-marketing",
});

const workflow = [
  {
    label: "Agent requests",
    description:
      "An external Agent asks for one temporary Task through remote MCP or canonical HTTP.",
  },
  {
    label: "Server authorizes",
    description:
      "Identity, Machine, duration, concurrency and Autonomy Policy are checked outside the model.",
  },
  {
    label: "Client enforces",
    description:
      "The Linux Client independently applies owner-controlled Local Policy before a Command runs.",
  },
  {
    label: "Work stays attributable",
    description:
      "Exact Commands and security metadata remain auditable. stdout and stderr expire instead of becoming a recording.",
  },
] as const;

const boundaries = [
  ["Network", "Outbound Machine connection. No inbound port, VPN route or shared SSH credential."],
  ["Identity", "Every Agent, Machine and Human has a distinct, revocable identity."],
  ["Authority", "The Server can narrow Local Policy, but it can never widen it."],
  ["Execution", "Commands run as the dedicated Linux user that runs the Client—never inside an implied sandbox."],
  ["Audit", "Command text and decisions are durable; credentials and retained output are not."],
] as const;

const interfaces = [
  {
    icon: TerminalIcon,
    title: "Remote MCP",
    description: "Agent-native tools with OAuth, resumable Tasks and explicit idempotency.",
  },
  {
    icon: KeyRoundIcon,
    title: "Canonical HTTP",
    description: "The same Task and Command model for runtimes that speak directly to the API.",
  },
  {
    icon: EyeIcon,
    title: "Optional supervision",
    description: "Humans observe, approve exceptions and audit work without becoming the primary operator.",
  },
] as const;

export default function HomePage() {
  return (
    <div className={cn(marketingFont.variable, "landing-page")}>
      <SiteHeader />
      <main id="main-content" tabIndex={-1}>
        <section className="landing-shell py-4 md:py-6">
          <div className="landing-inverted overflow-hidden rounded-xl bg-[var(--color-graphite)] text-[var(--color-graphite-ink)]">
            <div className="grid min-h-[calc(100svh-7.5rem)] gap-14 px-6 py-14 sm:px-10 lg:grid-cols-[0.92fr_1.08fr] lg:items-center lg:px-16 lg:py-16 xl:px-20">
              <div className="min-w-0">
                <p className="font-mono text-xs tracking-[0.12em] text-white/52 uppercase">
                  Agent-native infrastructure
                </p>
                <h1 className="display-balance mt-6 max-w-[13ch] text-[clamp(3.25rem,5.2vw,5.6rem)] leading-[0.94] font-medium tracking-[-0.05em]">
                  The control plane for agents on real machines.
                </h1>
                <p className="body-pretty mt-8 max-w-[39rem] text-lg leading-8 text-white/64 md:text-xl">
                  Give external Agents temporary, policy-bound shell access to customer
                  Linux Machines—without SSH, inbound ports or permanent keys.
                </p>
                <div className="mt-10 flex flex-wrap gap-3">
                  <Link
                    className={cn(buttonVariants({ size: "lg" }), "whitespace-nowrap")}
                    href="/sign-up"
                  >
                    Start free
                    <ArrowRightIcon data-icon="inline-end" />
                  </Link>
                  <Link
                    className={cn(
                      buttonVariants({ variant: "outline", size: "lg" }),
                      "whitespace-nowrap",
                    )}
                    href="/#agent-workflow"
                  >
                    See the control path
                  </Link>
                </div>
                <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-white/12 pt-5 font-mono text-xs text-white/48">
                  <span>Linux Client</span>
                  <span>OAuth MCP + HTTP</span>
                  <span>Cloud or self-hosted</span>
                </div>
              </div>
              <AgentCommandTrace />
            </div>
          </div>
        </section>

        <section id="agent-workflow" className="landing-shell grid gap-12 py-24 md:py-32 lg:grid-cols-[0.78fr_1.22fr]">
          <div>
            <p className="font-mono text-xs tracking-[0.12em] text-muted-foreground uppercase">
              One durable workflow
            </p>
            <h2 className="display-balance mt-5 max-w-[12ch] text-4xl leading-[1.05] font-medium tracking-[-0.035em] md:text-6xl">
              Agents act. Policy decides.
            </h2>
            <p className="body-pretty mt-6 max-w-md text-lg leading-8 text-muted-foreground">
              A Task binds one Agent to one Machine for a limited time. Commands inherit
              that boundary; they never invent their own authority.
            </p>
          </div>
          <ol className="border-t">
            {workflow.map((step, index) => (
              <li
                key={step.label}
                className="grid gap-4 border-b py-7 sm:grid-cols-[3rem_minmax(0,0.72fr)_minmax(0,1fr)] sm:gap-6"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="text-lg font-medium">{step.label}</h3>
                <p className="body-pretty leading-7 text-muted-foreground">
                  {step.description}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section id="product" className="landing-shell pb-24 md:pb-32">
          <div className="rounded-xl border bg-card px-6 py-8 sm:px-10 sm:py-12 lg:px-14 lg:py-16">
            <div className="grid gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:items-end">
              <div>
                <p className="font-mono text-xs tracking-[0.12em] text-muted-foreground uppercase">
                  One outbound route
                </p>
                <h2 className="display-balance mt-5 max-w-[13ch] text-4xl leading-[1.05] font-medium tracking-[-0.035em] md:text-5xl">
                  Reach the Machine. Never enter its network.
                </h2>
              </div>
              <p className="body-pretty max-w-2xl text-lg leading-8 text-muted-foreground">
                The Client authenticates outward to Odyshell. Agents operate through a
                policy-aware control plane, not through a reusable network credential.
              </p>
            </div>
            <ConnectionRoute />
          </div>
        </section>

        <section id="security" className="border-y bg-muted/40">
          <div className="landing-shell grid gap-12 py-24 md:py-32 lg:grid-cols-[0.72fr_1.28fr]">
            <div>
              <ShieldCheckIcon aria-hidden="true" className="text-muted-foreground" />
              <h2 className="display-balance mt-6 max-w-[12ch] text-4xl leading-[1.05] font-medium tracking-[-0.035em] md:text-5xl">
                Authority lives outside the model.
              </h2>
              <p className="body-pretty mt-6 max-w-md leading-7 text-muted-foreground">
                Prompts can request work. Odyshell and the Machine owner decide what can
                actually run.
              </p>
            </div>
            <dl className="border-t">
              {boundaries.map(([term, description]) => (
                <div
                  key={term}
                  className="grid gap-3 border-b py-6 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-8"
                >
                  <dt className="font-medium">{term}</dt>
                  <dd className="body-pretty leading-7 text-muted-foreground">
                    {description}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="landing-shell py-24 md:py-32">
          <div className="max-w-3xl">
            <p className="font-mono text-xs tracking-[0.12em] text-muted-foreground uppercase">
              Built for Agents first
            </p>
            <h2 className="display-balance mt-5 text-4xl leading-[1.05] font-medium tracking-[-0.035em] md:text-6xl">
              Protocols for autonomous work. A dashboard when humans need it.
            </h2>
          </div>
          <div className="mt-14 grid border-t md:grid-cols-3">
            {interfaces.map((item) => (
              <div
                key={item.title}
                className="border-b py-7 md:border-r md:px-7 md:last:border-r-0 md:first:pl-0 md:last:pr-0"
              >
                <item.icon aria-hidden="true" className="text-muted-foreground" />
                <h3 className="mt-8 text-xl font-medium">{item.title}</h3>
                <p className="body-pretty mt-3 leading-7 text-muted-foreground">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="landing-shell pb-24 md:pb-32">
          <div className="grid overflow-hidden rounded-xl border bg-card lg:grid-cols-[0.94fr_1.06fr]">
            <div className="flex flex-col justify-between gap-12 px-6 py-10 sm:px-10 sm:py-14 lg:px-14">
              <div>
                <p className="font-mono text-xs tracking-[0.12em] text-muted-foreground uppercase">
                  Same system, your boundary
                </p>
                <h2 className="display-balance mt-5 max-w-[12ch] text-4xl leading-[1.05] font-medium tracking-[-0.035em] md:text-5xl">
                  Run Odyshell where your Machines live.
                </h2>
                <p className="body-pretty mt-6 max-w-xl leading-7 text-muted-foreground">
                  Cloud and self-hosted deployments use the same Server, Better Auth
                  identity, PostgreSQL schema, MCP, HTTP protocol, dashboard and Linux
                  Client.
                </p>
              </div>
              <Link
                className={cn(buttonVariants({ size: "lg" }), "w-fit whitespace-nowrap")}
                href="/docs/self-hosting"
              >
                Self-host Odyshell
                <ArrowRightIcon data-icon="inline-end" />
              </Link>
            </div>
            <div className="flex min-h-[24rem] flex-col justify-between border-t bg-muted/55 p-6 sm:p-10 lg:border-t-0 lg:border-l">
              <div className="flex items-center justify-between gap-4 font-mono text-xs text-muted-foreground">
                <span>docker-compose.yml</span>
                <span>Single Organization</span>
              </div>
              <pre className="overflow-x-auto rounded-lg border bg-background p-5 text-sm leading-7">
                <code>{`cp .env.example .env
docker compose up -d --build
pnpm test:self-host`}</code>
              </pre>
              <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
                <span className="flex items-center gap-2">
                  <CheckIcon aria-hidden="true" className="text-status-success" />
                  Local identity
                </span>
                <span className="flex items-center gap-2">
                  <CheckIcon aria-hidden="true" className="text-status-success" />
                  No hosted analytics
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="landing-shell pb-24 md:pb-32">
          <div className="grid gap-10 border-y py-14 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <p className="font-mono text-xs tracking-[0.12em] text-muted-foreground uppercase">
                Build against one model
              </p>
              <h2 className="display-balance mt-5 max-w-[18ch] text-4xl leading-[1.05] font-medium tracking-[-0.035em] md:text-5xl">
                Connect an Agent. Enroll a Machine. Request a Task.
              </h2>
              <p className="body-pretty mt-5 max-w-2xl leading-7 text-muted-foreground">
                The documentation is written for both engineers and coding Agents from
                the same reviewed source.
              </p>
            </div>
            <Link
              className={cn(
                buttonVariants({ variant: "outline", size: "lg" }),
                "w-fit whitespace-nowrap",
              )}
              href="/docs"
            >
              Read the docs
              <ArrowRightIcon data-icon="inline-end" />
            </Link>
          </div>
        </section>

        <section className="landing-shell pb-6">
          <div className="landing-inverted rounded-xl bg-[var(--color-graphite)] px-6 py-16 text-[var(--color-graphite-ink)] sm:px-10 md:py-20 lg:px-16">
            <div className="flex max-w-4xl flex-col gap-8">
              <div className="flex items-center gap-3 font-mono text-xs text-white/52">
                <CloudIcon aria-hidden="true" />
                Agent infrastructure, under control
              </div>
              <h2 className="display-balance text-4xl leading-[1.02] font-medium tracking-[-0.04em] md:text-6xl">
                Give Agents a real Machine without giving away the network.
              </h2>
              <div className="flex flex-wrap gap-3">
                <Link
                  className={cn(buttonVariants({ size: "lg" }), "whitespace-nowrap")}
                  href="/sign-up"
                >
                  Start free
                  <ArrowRightIcon data-icon="inline-end" />
                </Link>
                <Link
                  className={cn(
                    buttonVariants({ variant: "outline", size: "lg" }),
                    "whitespace-nowrap",
                  )}
                  href="/sign-in"
                >
                  Sign in
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-shell py-10">
        <div className="flex flex-col gap-8 border-t pt-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span className="font-medium text-foreground">Odyshell</span>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <Link className="hover:text-foreground" href="/#product">
              Product
            </Link>
            <Link className="hover:text-foreground" href="/#security">
              Security
            </Link>
            <Link className="hover:text-foreground" href="/docs/self-hosting">
              Self-hosting
            </Link>
            <a className="hover:text-foreground" href="https://github.com/kapeka0/odyshell">
              GitHub
            </a>
          </div>
          <span>© 2026 Odyshell</span>
        </div>
      </footer>
    </div>
  );
}
