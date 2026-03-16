export function diffSummaryText(summary: unknown): string {
  if (typeof summary === "string") {
    return summary;
  }

  try {
    const serialized = JSON.stringify(summary);
    return serialized ?? String(summary);
  } catch {
    return String(summary);
  }
}
