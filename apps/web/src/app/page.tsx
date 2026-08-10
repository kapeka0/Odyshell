import { ArrowRightIcon, BotIcon, CheckIcon, Clock3Icon, CpuIcon, ShieldCheckIcon, TerminalIcon } from "lucide-react";
import { Manrope } from "next/font/google";
import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const marketingFont = Manrope({ subsets: ["latin"], display: "swap", variable: "--font-marketing" });

export default function HomePage() {
  return (
    <div className={cn(marketingFont.variable, "landing-page overflow-hidden")}>
      <SiteHeader />
      <main id="main-content" tabIndex={-1}>
        <section className="landing-shell flex min-h-[44rem] flex-col items-center px-4 pb-14 pt-24 text-center md:pt-32">
          <div className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-xs">
            <span className="size-1.5 rounded-full bg-status-success" />
            Free and self-hosted · Linux, macOS, and Windows
          </div>
          <h1 className="display-balance mt-8 max-w-[13ch] text-[clamp(3.4rem,8vw,7.5rem)] font-semibold leading-[0.9] tracking-[-0.065em]">
            Let agents work.<br />Keep the keys.
          </h1>
          <p className="body-pretty mt-8 max-w-2xl text-lg leading-8 text-muted-foreground md:text-xl">
            Temporary, approved shell Sessions for AI agents on real Machines. No shared SSH credentials, no inbound ports, no VPN.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <a href="https://github.com/kapeka0/odyshell" className={buttonVariants({ size: "lg" })}>Deploy Odyshell <ArrowRightIcon data-icon="inline-end" /></a>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">One Docker Compose stack. Unlimited members, Machines, and Agents.</p>
        </section>

        <section id="product" className="landing-shell pb-24 md:pb-32">
          <ProductPreview />
          <div className="mt-8 grid gap-3 text-center text-xs text-muted-foreground sm:grid-cols-3">
            <p>No SSH keys handed to agents</p><p>OAuth approval in the browser</p><p>Every command attributable</p>
          </div>
        </section>

        <section className="border-y bg-muted/35">
          <div className="landing-shell py-24 md:py-32">
            <div className="mx-auto max-w-3xl text-center">
              <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">One authority model</p>
              <h2 className="display-balance mt-5 text-4xl font-semibold leading-[1.02] tracking-[-0.045em] md:text-6xl">One Agent. One Machine. One expiring Session.</h2>
              <p className="body-pretty mt-6 text-lg leading-8 text-muted-foreground">The agent asks through MCP. A Human approves in the browser. The Machine enforces the local ceiling.</p>
            </div>
            <div className="mt-16 grid gap-px overflow-hidden rounded-xl border bg-border md:grid-cols-3">
              <FeatureStep number="01" icon={<BotIcon />} title="Agent requests" description="The Agent selects a Machine, explains the purpose, and asks for 15 minutes to 24 hours." />
              <FeatureStep number="02" icon={<ShieldCheckIcon />} title="Human approves" description="Standard Agents wait for explicit Organization approval. Operators can proceed without a new prompt." />
              <FeatureStep number="03" icon={<TerminalIcon />} title="Machine executes" description="Commands run through an outbound Client and appear with output in the Session timeline." />
            </div>
          </div>
        </section>

        <section id="security" className="landing-shell py-24 md:py-32">
          <div className="grid items-center gap-14 lg:grid-cols-[0.86fr_1.14fr]">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">Traceability built in</p>
              <h2 className="display-balance mt-5 max-w-[12ch] text-4xl font-semibold leading-[1.02] tracking-[-0.045em] md:text-6xl">See exactly what happened.</h2>
              <p className="body-pretty mt-6 max-w-lg text-lg leading-8 text-muted-foreground">Open any Session to inspect who requested it, who approved it, which Machine was touched, every command, its output, and its exit state.</p>
              <ul className="mt-8 grid gap-3 text-sm">
                <CheckLine>Human and Agent identities remain distinct</CheckLine>
                <CheckLine>Operator promotion is explicit and revocable</CheckLine>
                <CheckLine>Downgrading an Operator closes active Sessions</CheckLine>
              </ul>
            </div>
            <TimelinePreview />
          </div>
        </section>

        <section className="border-y bg-neutral-950 text-white">
          <div className="landing-shell grid gap-12 py-24 md:py-32 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.14em] text-white/50">Made for agent tooling</p>
              <h2 className="display-balance mt-5 max-w-[12ch] text-4xl font-semibold leading-[1.02] tracking-[-0.045em] md:text-6xl">MCP in. Shell out.</h2>
              <p className="body-pretty mt-6 max-w-lg text-lg leading-8 text-white/60">Agents discover Machines, request a Session, execute bounded commands, read output, and finish early using one canonical protocol.</p>
            </div>
            <div className="overflow-hidden rounded-xl border border-white/12 bg-white/[0.04] shadow-2xl">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 font-mono text-xs text-white/45"><span>agent.mcp</span><span>Operator · production-api</span></div>
              <pre className="overflow-x-auto p-6 font-mono text-sm leading-7 text-white/80"><code>{`session = odyshell.request_session({
  machineId: "production-api",
  durationSeconds: 3600,
  purpose: "Deploy release 2.4.0"
})

odyshell.run_command({
  sessionId: session.id,
  command: "pnpm deploy"
})

odyshell.finish_session(session.id)`}</code></pre>
            </div>
          </div>
        </section>

        <section id="self-hosting" className="landing-shell py-24 md:py-32">
          <div className="grid gap-14 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">Community infrastructure</p>
              <h2 className="display-balance mt-5 max-w-[12ch] text-4xl font-semibold leading-[1.02] tracking-[-0.045em] md:text-6xl">Your control plane. Your data.</h2>
              <p className="body-pretty mt-6 max-w-lg text-lg leading-8 text-muted-foreground">Run the complete product with Docker Compose on a workstation, homelab, private server, or VPS. Odyshell has no hosted tier, commercial limits, or required third-party services.</p>
              <div className="mt-9 flex flex-wrap gap-3">
                <a href="https://github.com/kapeka0/odyshell" className={buttonVariants({ size: "lg" })}>Deploy Odyshell <ArrowRightIcon data-icon="inline-end" /></a>
                <Link href="/docs/self-hosting" className={buttonVariants({ variant: "outline", size: "lg" })}>Self-hosting guide</Link>
              </div>
            </div>
            <div className="overflow-hidden rounded-2xl border bg-neutral-950 text-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-3 font-mono text-xs text-white/45"><span>odyshell · self-hosted</span><span>Apache-2.0</span></div>
              <pre className="overflow-x-auto p-6 font-mono text-sm leading-7 text-white/80"><code>{`git clone https://github.com/kapeka0/odyshell.git
cd odyshell
cp .env.example .env
docker compose up --build`}</code></pre>
              <div className="grid gap-px border-t border-white/10 bg-white/10 sm:grid-cols-3">
                {[["Members", "Unlimited"], ["Machines", "Unlimited"], ["Agents", "Unlimited"]].map(([label, value]) => <div key={label} className="bg-neutral-950 px-5 py-4"><p className="font-mono text-[11px] uppercase tracking-wider text-white/40">{label}</p><p className="mt-1 text-sm font-medium">{value}</p></div>)}
              </div>
            </div>
          </div>
        </section>

        <section className="landing-shell pb-8">
          <div className="rounded-2xl bg-neutral-950 px-6 py-20 text-center text-white sm:px-10 md:py-28">
            <h2 className="display-balance mx-auto max-w-[15ch] text-4xl font-semibold leading-[1] tracking-[-0.05em] md:text-6xl">Give agents a shell, not your network.</h2>
            <p className="mx-auto mt-6 max-w-xl text-lg leading-8 text-white/60">Connect a Machine in minutes and keep every Session temporary, bounded, and visible.</p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              <a href="https://github.com/kapeka0/odyshell" className={buttonVariants({ size: "lg" })}>Deploy Odyshell <ArrowRightIcon data-icon="inline-end" /></a>
            </div>
          </div>
        </section>
      </main>
      <footer className="landing-shell py-10">
        <div className="flex flex-col gap-6 border-t pt-7 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span className="font-semibold text-foreground">Odyshell</span>
          <div className="flex flex-wrap gap-5"><Link href="/#product">Product</Link><Link href="/#security">Security</Link><Link href="/#self-hosting">Self-hosting</Link><a href="https://github.com/kapeka0/odyshell">GitHub</a></div>
          <span>© 2026 Odyshell</span>
        </div>
      </footer>
    </div>
  );
}

function ProductPreview() {
  return (
    <div className="relative rounded-2xl border bg-muted/55 p-2 shadow-[0_32px_100px_-44px_rgba(0,0,0,0.5)] sm:p-4">
      <div className="overflow-hidden rounded-xl border bg-background">
        <div className="flex h-11 items-center gap-2 border-b px-4"><span className="size-2.5 rounded-full bg-border" /><span className="size-2.5 rounded-full bg-border" /><span className="size-2.5 rounded-full bg-border" /><span className="ml-3 font-mono text-[11px] text-muted-foreground">Overview · Live topology</span></div>
        <div className="relative min-h-[29rem] bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:22px_22px]">
          <div className="absolute left-[7%] top-[18%] w-44 rounded-xl border bg-card p-4 shadow-sm"><PreviewTitle icon={<BotIcon />} title="release-agent" status="Operator" /><p className="mt-4 border-t pt-3 text-xs text-muted-foreground">1 live Session</p></div>
          <div className="absolute left-[39%] top-[39%] w-48 rounded-xl border bg-card p-4 shadow-sm"><PreviewTitle icon={<Clock3Icon />} title="Deploy 2.4.0" status="42m left" /><p className="mt-4 border-t pt-3 text-xs text-muted-foreground">Active Session</p></div>
          <div className="absolute right-[6%] top-[20%] w-48 rounded-xl border bg-card p-4 shadow-sm"><PreviewTitle icon={<CpuIcon />} title="production-api" status="Online" /><p className="mt-4 border-t pt-3 text-xs text-muted-foreground">Linux · odyshell</p></div>
          <svg aria-hidden="true" className="absolute inset-0 size-full text-muted-foreground/55"><path d="M 180 150 C 280 150, 330 250, 430 250" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="6 6"/><path d="M 585 250 C 680 250, 710 150, 800 150" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="6 6"/></svg>
          <div className="absolute bottom-4 left-4 flex gap-2"><span className="rounded-lg border bg-background px-3 py-1.5 text-xs text-muted-foreground">2/2 Machines online</span><span className="rounded-lg border bg-background px-3 py-1.5 text-xs text-muted-foreground">1 live Session</span></div>
        </div>
      </div>
    </div>
  );
}

function PreviewTitle({ icon, title, status }: { icon: React.ReactNode; title: string; status: string }) { return <div className="flex items-center gap-3"><span className="flex size-9 items-center justify-center rounded-lg border bg-muted [&_svg]:size-4">{icon}</span><span className="min-w-0"><strong className="block truncate text-sm">{title}</strong><small className="text-muted-foreground">{status}</small></span></div>; }
function FeatureStep({ number, icon, title, description }: { number: string; icon: React.ReactNode; title: string; description: string }) { return <article className="bg-background p-7 md:p-9"><div className="flex items-center justify-between text-muted-foreground"><span className="[&_svg]:size-5">{icon}</span><span className="font-mono text-xs">{number}</span></div><h3 className="mt-12 text-xl font-semibold">{title}</h3><p className="mt-3 leading-7 text-muted-foreground">{description}</p></article>; }
function CheckLine({ children }: { children: React.ReactNode }) { return <li className="flex items-center gap-3"><CheckIcon className="size-4 text-status-success" />{children}</li>; }

function TimelinePreview() {
  const entries = [["Session requested", "release-agent · Operator"], ["Machine opened", "production-api · user odyshell"], ["Command completed", "$ pnpm deploy · exit 0"]];
  return <div className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8"><div className="flex items-center justify-between border-b pb-5"><div><p className="font-semibold">Deploy release 2.4.0</p><p className="mt-1 text-xs text-muted-foreground">Session 8d3f...2a9c</p></div><span className="rounded-md bg-status-success/10 px-2 py-1 text-xs text-status-success">Active</span></div><ol className="mt-6">{entries.map(([title, detail], index) => <li key={title} className="relative grid grid-cols-[1.5rem_1fr] gap-3 pb-7 last:pb-0"><span className="relative z-10 mt-1 size-3 rounded-full border-2 border-background bg-foreground ring-1 ring-border" />{index < entries.length - 1 ? <span className="absolute bottom-0 left-[5px] top-3 w-px bg-border" /> : null}<div><p className="text-sm font-medium">{title}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{detail}</p></div></li>)}</ol></div>;
}
