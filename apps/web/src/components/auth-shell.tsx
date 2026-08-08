import { Brand } from "@/components/brand";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-svh">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="flex h-16 items-center border-b px-4 md:px-8">
        <Brand />
      </header>
      <div
        id="main-content"
        tabIndex={-1}
        className="mx-auto grid min-h-[calc(100svh-4rem)] w-full max-w-6xl items-center gap-12 px-4 py-12 lg:grid-cols-[minmax(0,1fr)_28rem] lg:px-8"
      >
        <section className="hidden max-w-xl lg:block">
          <p className="text-sm text-muted-foreground">Odyshell Cloud</p>
          <h1 className="mt-3 text-5xl leading-[1.02] font-semibold tracking-[-0.04em]">
            Govern agents acting on real machines.
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-8 text-muted-foreground">
            Manage outbound Machine Clients, temporary Tasks, optional human
            supervision, and exact-command audit from one Organization.
          </p>
        </section>

        <Card className="w-full">
          <CardHeader className="border-b pb-4">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent className="pt-4">{children}</CardContent>
        </Card>
      </div>
    </main>
  );
}
