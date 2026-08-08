import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
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
    default: "Odyshell | Agent access to private machines",
    template: "%s | Odyshell",
  },
  description:
    "Give AI agents scoped, temporary and auditable access to private machines without SSH, inbound ports or a VPN.",
  icons: {
    icon: [
      {
        url: "/brand/odyshell-square-light.svg",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: "/brand/odyshell-square-dark.svg",
        media: "(prefers-color-scheme: dark)",
      },
    ],
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
        <Providers>{children}</Providers>
        <Analytics />
      </body>
    </html>
  );
}
