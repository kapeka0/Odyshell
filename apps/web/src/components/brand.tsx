import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

export function Brand({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <Link
      href="/"
      aria-label="Odyshell home"
      className={cn("inline-flex items-center gap-2.5 whitespace-nowrap font-heading font-semibold", className)}
    >
      <Image
        src="/brand/odyshell-on-light.svg"
        alt=""
        width={19}
        height={19}
        className="dark:hidden"
        priority
      />
      <Image
        src="/brand/odyshell-on-dark.svg"
        alt=""
        width={19}
        height={19}
        className="hidden dark:block"
        priority
      />
      {!compact && <span>Odyshell</span>}
    </Link>
  );
}
