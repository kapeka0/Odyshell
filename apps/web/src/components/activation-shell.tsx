import { Brand } from "@/components/brand";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function ActivationShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="grid min-h-svh place-items-center px-4 py-12">
      <a className="skip-link" href="#activation-content">
        Skip to approval
      </a>
      <Card id="activation-content" className="w-full max-w-md" tabIndex={-1}>
        <CardHeader>
          <Brand compact className="mb-6 w-fit" />
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}
