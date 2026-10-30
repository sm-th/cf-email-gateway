export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const FAILURES: Record<string, true> = {
  rejected: true,
  send_failed: true,
  push_failed: true,
  auth_failed: true,
  config_error: true,
};

/** Writes one JSON line per event; failures go to stderr. */
export function log(event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ event, ...fields });
  if (FAILURES[event]) console.error(line);
  else console.log(line);
}
