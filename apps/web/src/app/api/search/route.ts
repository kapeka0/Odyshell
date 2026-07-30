import { createFromSource } from "fumadocs-core/search/server";
import { validDocumentationSearchQuery } from "@/lib/documentation-search";
import { source } from "@/lib/source";

const search = createFromSource(source);

export function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("query") ?? "";
  if (!validDocumentationSearchQuery(query)) {
    return Response.json(
      { error: "invalid_search_query" },
      {
        status: 400,
        headers: { "X-Content-Type-Options": "nosniff" },
      },
    );
  }

  return search.GET(request);
}
