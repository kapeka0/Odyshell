import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export default defineConfig({
  mdxOptions: {
    remarkNpmOptions: {
      persist: {
        id: "package-manager",
      },
    },
  },
});

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});
