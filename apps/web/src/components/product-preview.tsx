import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

const machines = [
  { name: "production-api", platform: "linux · x64", status: "Online" },
  { name: "studio-mac", platform: "darwin · arm64", status: "Online" },
  { name: "rpi5", platform: "linux · arm64", status: "Offline" },
] as const;

export function ProductPreview() {
  return (
    <figure aria-label="Odyshell workspace preview" className="overflow-hidden rounded-[var(--radius-panel)] border bg-card">
      <figcaption className="flex items-center justify-between gap-4 border-b px-5 py-4">
        <div>
          <p className="font-heading text-sm font-semibold">Default workspace</p>
          <p className="font-mono text-xs text-muted-foreground">3 machines · 1 active session</p>
        </div>
        <Badge variant="outline">Free</Badge>
      </figcaption>
      <div className="grid min-h-72 md:grid-cols-[0.9fr_1.1fr]">
        <div className="border-b p-5 md:border-r md:border-b-0">
          <p className="mb-4 font-mono text-xs uppercase tracking-wider text-muted-foreground">Machines</p>
          <div className="flex flex-col">
            {machines.map((machine, index) => (
              <div key={machine.name}>
                <div className="flex items-center gap-3 py-3">
                  <span
                    aria-label={machine.status}
                    className={cnStatus(machine.status)}
                  />
                  <div className="min-w-0">
                    <p className="truncate font-heading text-sm font-medium">{machine.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">{machine.platform}</p>
                  </div>
                </div>
                {index < machines.length - 1 && <Separator />}
              </div>
            ))}
          </div>
        </div>
        <div className="bg-[var(--color-graphite)] p-5 text-[var(--color-graphite-ink)]">
          <div className="flex items-center justify-between gap-3">
            <p className="font-mono text-xs uppercase tracking-wider text-[var(--color-muted)]">Operation trace</p>
            <Badge className="bg-[var(--color-success)] text-[var(--color-accent-ink)]">Succeeded</Badge>
          </div>
          <pre className="mt-8 overflow-x-auto font-mono text-sm leading-7">
            <code>
              <span className="text-[var(--color-muted)]">$ </span>
              <span>ods exec production-api -- npm update</span>
              {"\n\n"}
              <span className="text-[var(--color-accent)]">session.created</span>
              {"\n"}
              <span className="text-[var(--color-muted)]">scope </span>
              <span>process.exec</span>
              {"\n"}
              <span className="text-[var(--color-muted)]">ttl   </span>
              <span>00:15:00</span>
              {"\n\n"}
              <span>updated 4 packages</span>
              {"\n"}
              <span className="text-[var(--color-success)]">exit 0</span>
            </code>
          </pre>
        </div>
      </div>
    </figure>
  );
}

function cnStatus(status: string) {
  return status === "Online"
    ? "size-2 shrink-0 rounded-full bg-[var(--color-success)]"
    : "size-2 shrink-0 rounded-full bg-[var(--color-muted)]";
}
