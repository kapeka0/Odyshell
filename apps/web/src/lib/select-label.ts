export function selectDisplayLabel(
  label: string,
  options: ReadonlyArray<{ label: string; value: string }>,
  value: string,
): string {
  if (value === "all") return `All ${label}`;
  return options.find((option) => option.value === value)?.label ?? label;
}
