import * as motion from "motion/react-client";
import { ArrowRightIcon, CheckIcon, LockKeyholeIcon } from "lucide-react";
import Link from "next/link";
import { ConnectionRoute } from "@/components/connection-route";
import { ProductPreview } from "@/components/product-preview";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const boundaries = [
  ["Connectivity", "Outbound from the machine", "No inbound ports"],
  ["Identity", "Machine key + workspace token", "No SSH credentials"],
  ["Authority", "Capabilities and machine scopes", "Default deny"],
  ["Time", "Expiring agent sessions", "Access ends automatically"],
  ["Evidence", "Operation metadata and results", "No secret recording"],
] as const;

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="page-shell grid gap-12 py-20 md:py-28 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
            className="flex min-w-0 flex-col items-start gap-7"
          >
            <Badge variant="outline">Infrastructure for AI agents</Badge>
            <div className="flex flex-col gap-5">
              <h1 className="display-balance max-w-[11ch] text-[clamp(3rem,7vw,5.25rem)] leading-[0.96] font-semibold tracking-[-0.045em]">
                Give agents access. Keep the keys.
              </h1>
              <p className="body-pretty max-w-[58ch] text-lg leading-8 text-muted-foreground">
                Run scoped operations on private machines without SSH credentials, inbound ports or a VPN. Every request passes through policy and leaves an audit event.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link className={cn(buttonVariants({ size: "lg" }), "whitespace-nowrap")} href="/sign-up">
                Start free
                <ArrowRightIcon data-icon="inline-end" />
              </Link>
              <Link className={cn(buttonVariants({ variant: "outline", size: "lg" }), "whitespace-nowrap")} href="/#how-it-works">
                See the flow
              </Link>
            </div>
            <p className="font-mono text-xs text-muted-foreground">Linux · macOS · Windows · outbound only</p>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.42, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
            className="min-w-0"
          >
            <ProductPreview />
          </motion.div>
        </section>

        <section className="page-shell pb-24">
          <ConnectionRoute />
        </section>

        <section id="how-it-works" className="bg-[var(--color-graphite)] text-[var(--color-graphite-ink)]">
          <div className="page-shell grid gap-14 py-24 lg:grid-cols-[0.7fr_1.3fr]">
            <div className="max-w-md">
              <h2 className="display-balance text-4xl leading-tight font-semibold tracking-tight">One approval. One workspace. No network access.</h2>
              <p className="mt-5 leading-7 text-[var(--color-muted)]">
                The web owns people and plans. The CLI requests access. The client on each machine maintains the outbound route.
              </p>
            </div>
            <ol className="border-t border-[var(--color-graphite-raised)]">
              {[
                ["Run ods login", "The CLI creates a short-lived device code and opens the Odyshell web app."],
                ["Approve in the browser", "Clerk confirms the user and organization. Odyshell binds the CLI to that workspace."],
                ["Connect a machine", "A one-time enrollment token gives the local client an identity. It connects outbound and waits."],
              ].map(([title, description], index) => (
                <li key={title} className="grid gap-4 border-b border-[var(--color-graphite-raised)] py-7 sm:grid-cols-[4rem_1fr]">
                  <span className="font-mono text-sm text-[var(--color-accent)]">{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <h3 className="text-xl font-semibold">{title}</h3>
                    <p className="mt-2 max-w-[60ch] leading-7 text-[var(--color-muted)]">{description}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="security" className="page-shell grid gap-12 py-24 lg:grid-cols-[0.75fr_1.25fr]">
          <div>
            <div className="flex gap-3">
              <LockKeyholeIcon className="text-primary" />
              <h2 className="display-balance text-4xl leading-tight font-semibold tracking-tight">Control lives outside the model.</h2>
            </div>
            <p className="mt-5 max-w-[48ch] leading-7 text-muted-foreground">
              Prompts can ask. Odyshell decides. Machine identity, capability checks, expiry and path boundaries are enforced before an operation reaches the client.
            </p>
          </div>
          <div className="overflow-hidden rounded-[var(--radius-surface)] border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Boundary</TableHead>
                  <TableHead>Odyshell uses</TableHead>
                  <TableHead className="hidden md:table-cell">Agent never receives</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {boundaries.map(([boundary, control, excluded]) => (
                  <TableRow key={boundary}>
                    <TableCell className="font-heading font-medium">{boundary}</TableCell>
                    <TableCell>{control}</TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">{excluded}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        <Separator />

        <section id="plans" className="page-shell py-24">
          <div className="grid gap-12 lg:grid-cols-[0.7fr_1.3fr]">
            <div>
              <h2 className="display-balance text-4xl leading-tight font-semibold tracking-tight">Start with the useful limit.</h2>
              <p className="mt-5 max-w-[45ch] leading-7 text-muted-foreground">
                Plans limit managed capacity. They never weaken execution policy or shorten the audit trail to create an upgrade.
              </p>
            </div>
            <div className="grid gap-5 md:grid-cols-[0.9fr_1.1fr]">
              <Card>
                <CardHeader>
                  <CardTitle>Free</CardTitle>
                  <CardDescription>For one person proving the workflow.</CardDescription>
                  <CardAction><Badge>$0</Badge></CardAction>
                </CardHeader>
                <CardContent>
                  <PlanList items={["2 machines", "1 workspace", "3 active agent tokens", "All operation capabilities"]} />
                </CardContent>
                <CardFooter>
                  <Link className={cn(buttonVariants({ size: "lg" }), "w-full whitespace-nowrap")} href="/sign-up">
                    Create workspace
                  </Link>
                </CardFooter>
              </Card>
              <Card className="border-[var(--color-rule-strong)]">
                <CardHeader>
                  <CardTitle>Team</CardTitle>
                  <CardDescription>Shared administration and more connected machines.</CardDescription>
                  <CardAction><Badge variant="outline">Soon</Badge></CardAction>
                </CardHeader>
                <CardContent>
                  <PlanList items={["10 machines", "3 workspaces", "25 active agent tokens", "Team roles and shared audit"]} />
                </CardContent>
                <CardFooter>
                  <span className="text-sm text-muted-foreground">Billing will be enabled after the MVP validates usage.</span>
                </CardFooter>
              </Card>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="page-shell py-16">
          <p className="display-balance max-w-[24ch] font-heading text-4xl leading-tight font-semibold tracking-tight">
            Let the agent operate. Keep the machine private.
          </p>
          <div className="mt-12 flex flex-col gap-4 border-t pt-5 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span className="font-heading font-semibold text-foreground">Odyshell</span>
            <div className="flex flex-wrap gap-5">
              <Link className="whitespace-nowrap hover:text-foreground" href="/#how-it-works">How it works</Link>
              <Link className="whitespace-nowrap hover:text-foreground" href="/dashboard">Dashboard</Link>
              <a className="whitespace-nowrap hover:text-foreground" href="https://github.com/kapeka0/odyshell">GitHub</a>
            </div>
            <span>© 2026 Odyshell</span>
          </div>
        </div>
      </footer>
    </>
  );
}

function PlanList({ items }: { items: readonly string[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item} className="flex items-center gap-3 text-sm">
          <CheckIcon className="text-[var(--color-success)]" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
