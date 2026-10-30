export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Writes one JSON line per event; failures go to stderr. */
export function log(event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ event, ...fields });
  if (event === "rejected" || event === "send_failed" || event === "push_failed") console.error(line);
  else console.log(line);
}
