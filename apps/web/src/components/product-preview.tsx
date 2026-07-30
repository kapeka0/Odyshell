import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

const machines = [
  { name: "production-api", platform: "linux · x64", status: "Online" },
  { name: "studio-mac", platform: "darwin · arm64", status: "Online" },
  { name: "rpi5", platform: "linux · arm64", status: "Offline" },
] as const;

export function ProductPreview() {
  return (
    <figure
      aria-label="Odyshell workspace preview"
      className="overflow-hidden rounded-xl border bg-card shadow-sm"
    >
      <figcaption className="flex items-center justify-between gap-4 border-b px-5 py-4">
        <div>
          <p className="font-heading text-sm font-semibold">Default workspace</p>
          <p className="font-mono text-xs text-muted-foreground">
            3 machines · 1 active access
          </p>
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
        <div className="bg-muted/35 p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="font-mono text-xs text-muted-foreground">Policy decision</p>
            <Badge>Allowed</Badge>
          </div>
          <pre className="mt-8 overflow-x-auto font-mono text-sm leading-7">
            <code>
              <span className="text-muted-foreground">agent       </span>
              <span>deploy-agent</span>
              {"\n"}
              <span className="text-muted-foreground">machine     </span>
              <span>production-api</span>
              {"\n"}
              <span className="text-muted-foreground">capability  </span>
              <span>process.exec</span>
              {"\n"}
              <span className="text-muted-foreground">expires     </span>
              <span>in 42 minutes</span>
              {"\n\n"}
              <span className="text-muted-foreground">event       </span>
              <span>operation.created</span>
              {"\n"}
              <span className="text-[var(--color-success)]">decision    allowed</span>
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
