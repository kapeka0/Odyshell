"use client";

import { MotionConfig } from "motion/react";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <MotionConfig reducedMotion="user">
        <TooltipProvider delay={800}>{children}</TooltipProvider>
      </MotionConfig>
    </ThemeProvider>
  );
}
