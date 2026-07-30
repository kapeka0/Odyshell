import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import { docsLayoutOptions } from "@/lib/docs-layout";
import { source } from "@/lib/source";

export default function DocumentationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RootProvider
      theme={{ enabled: false }}
      search={{ options: { api: "/api/search" } }}
    >
      <DocsLayout
        {...docsLayoutOptions()}
        tree={source.getPageTree()}
        tabs={false}
        sidebar={{ prefetch: false }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
