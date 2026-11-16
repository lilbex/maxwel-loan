/** Reads the SQLSTATE from a driver error, including when Drizzle wraps it. */
export function pgError(error: unknown): { code?: string; constraint?: string } {
  let current = error as { code?: string; constraint?: string; cause?: unknown } | undefined;
  while (current) {
    if (typeof current.code === 'string') return current;
    current = current.cause as typeof current;
  }
  return {};
}

export const PG_UNIQUE_VIOLATION = '23505';
