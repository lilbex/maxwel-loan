import { sql } from 'drizzle-orm';
import type { Tx } from '../db/database.service.js';
import { tenantCounters } from '../db/schema.js';

/** Next number for this lender. The row lock is held until commit, so numbers have no gaps. */
export async function nextReference(tx: Tx, tenantId: string, prefix: string): Promise<string> {
  const [row] = await tx
    .insert(tenantCounters)
    .values({ tenantId, name: prefix, value: 1n })
    .onConflictDoUpdate({
      target: [tenantCounters.tenantId, tenantCounters.name],
      set: { value: sql`${tenantCounters.value} + 1` },
    })
    .returning({ value: tenantCounters.value });
  return `${prefix}-${row!.value.toString().padStart(5, '0')}`;
}
