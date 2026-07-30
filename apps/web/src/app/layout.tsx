import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/themes";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const bodyFont = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
  display: "swap",
});

const monoFont = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://odyshell.com"),
  title: {
    default: "Odyshell — Agent access to private machines",
    template: "%s — Odyshell",
  },
  description:
    "Give AI agents scoped, temporary and auditable access to private machines without SSH, inbound ports or a VPN.",
  icons: {
    icon: "/brand/odyshell-square-light.svg",
  },
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Odyshell — Agent access to private machines",
    description:
      "Scoped, temporary access to private machines without SSH, inbound ports or a VPN.",
    url: "https://odyshell.com",
    siteName: "Odyshell",
    type: "website",
  },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${bodyFont.variable} ${monoFont.variable}`}>
        <ClerkProvider
          dynamic
          appearance={{
            theme: shadcn,
            cssLayerName: "clerk",
            options: {
              elevation: "flush",
              logoImageUrl: "https://odyshell.com/brand/odyshell-square-light.svg",
              logoLinkUrl: "https://odyshell.com",
              shimmer: false,
            },
          }}
          signInUrl="/sign-in"
          signUpUrl="/sign-up"
          signInFallbackRedirectUrl="/dashboard"
          signUpFallbackRedirectUrl="/dashboard"
        >
          <Providers>{children}</Providers>
        </ClerkProvider>
      </body>
    </html>
  );
}
