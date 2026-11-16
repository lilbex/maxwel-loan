import type { ProductPenalty } from '@loan-platform/api-client';

export interface PenaltyInstallment {
  id: string;
  dueDate: string;
  totalKobo: bigint;
}

export interface DatedPayment {
  scheduleItemId: string;
  paymentDate: string;
  amountKobo: bigint;
}

export interface PenaltyCharge {
  scheduleItemId: string;
  chargeDate: string;
  amountKobo: bigint;
  basisKobo: bigint;
}

const STEP_DAYS = { daily: 1, weekly: 7, monthly: 30 };

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const roundDiv = (n: bigint, d: bigint) => (2n * n + d) / (2n * d);

function percentOf(amount: bigint, percent: string): bigint {
  const [whole, decimals = ''] = percent.split('.');
  return roundDiv(amount * BigInt(`${whole}${decimals}`), 100n * 10n ** BigInt(decimals.length));
}

/**
 * Pure penalty rule: every charge a loan should have by a given date. The first falls the day
 * after the grace period ends. Each charge is based on what was unpaid on that installment on
 * that date, leaving out earlier penalties, so penalties never compound. Charging stops once
 * the installment is cleared. The job adds whatever is missing, so a late run catches up.
 * chargeAfter skips dates up to that day, for loans moved in from paper records.
 */
export function expectedPenalties(
  penalty: ProductPenalty,
  installments: PenaltyInstallment[],
  payments: DatedPayment[],
  asOf: string,
  chargeAfter?: string,
): PenaltyCharge[] {
  if (penalty.type === 'none') return [];
  const charges: PenaltyCharge[] = [];

  for (const installment of installments) {
    const unpaidOn = (date: string) =>
      payments
        .filter((payment) => payment.scheduleItemId === installment.id && payment.paymentDate <= date)
        .reduce((left, payment) => left - payment.amountKobo, installment.totalKobo);

    let date = addDays(installment.dueDate, penalty.graceDays + 1);
    while (date <= asOf) {
      const basisKobo = unpaidOn(date);
      if (basisKobo <= 0n) break;
      const amountKobo = penalty.type === 'flat' ? BigInt(penalty.amountKobo) : percentOf(basisKobo, penalty.percent);
      const chargeable = !chargeAfter || date > chargeAfter;
      if (amountKobo > 0n && chargeable) charges.push({ scheduleItemId: installment.id, chargeDate: date, amountKobo, basisKobo });
      if (penalty.frequency === 'once') break;
      date = addDays(date, STEP_DAYS[penalty.frequency]);
    }
  }
  return charges;
}
