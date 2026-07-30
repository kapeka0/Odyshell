import type { MDXComponents } from "mdx/types";
import { getMDXComponents } from "./src/components/mdx";

export function useMDXComponents(): MDXComponents {
  return getMDXComponents();
}
