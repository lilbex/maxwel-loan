import type { AllocationBucket } from '@loan-platform/api-client';

export interface OpenInstallment {
  id: string;
  remaining: Record<AllocationBucket, bigint>;
}

export interface Allocation {
  scheduleItemId: string | null;
  bucket: AllocationBucket | 'overpayment';
  amountKobo: bigint;
}

/**
 * Pure allocation rule. A payment clears the oldest installment first, and within an
 * installment it follows the product's payment order. Anything left after every installment
 * is cleared is held as an overpayment.
 */
export function allocatePayment(
  amountKobo: bigint,
  installments: OpenInstallment[],
  order: AllocationBucket[],
): Allocation[] {
  const allocations: Allocation[] = [];
  let left = amountKobo;
  for (const installment of installments) {
    for (const bucket of order) {
      if (left === 0n) return allocations;
      const owed = installment.remaining[bucket];
      if (owed <= 0n) continue;
      const paid = owed < left ? owed : left;
      allocations.push({ scheduleItemId: installment.id, bucket, amountKobo: paid });
      left -= paid;
    }
  }
  if (left > 0n) allocations.push({ scheduleItemId: null, bucket: 'overpayment', amountKobo: left });
  return allocations;
}
