import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { InstallmentStatus, LoanInstallment, LoanOutstanding } from '@loan-platform/api-client';
import type { Tx } from '../../db/database.service.js';
import { paymentAllocations, payments, penaltyCharges, penaltyWaivers, scheduleItems, tenants } from '../../db/schema.js';
import type { OpenInstallment } from './allocation.js';

export interface LoanPosition {
  open: OpenInstallment[];
  installments: LoanInstallment[];
  outstanding: LoanOutstanding;
  outstandingTotal: bigint;
  /** Installment ids alongside `installments`, used by the collections report. */
  itemIds: string[];
}

export async function tenantToday(tx: Tx): Promise<string> {
  const [tenant] = await tx
    .select({ today: sql<string>`(now() AT TIME ZONE ${tenants.timezone})::date::text` })
    .from(tenants);
  return tenant!.today;
}

/**
 * Where loans stand, worked out from their fixed schedules, uncorrected payments, penalty
 * charges and waivers. Nothing is stored, so it can never drift from the records underneath.
 */
export async function loanPositions(tx: Tx, loanIds: string[]): Promise<Map<string, LoanPosition>> {
  const positions = new Map<string, LoanPosition>();
  if (loanIds.length === 0) return positions;

  const today = await tenantToday(tx);
  const items = await tx
    .select()
    .from(scheduleItems)
    .where(inArray(scheduleItems.loanId, loanIds))
    .orderBy(asc(scheduleItems.loanId), asc(scheduleItems.number));

  const correction = alias(payments, 'correction');
  const paid = await tx
    .select({
      loanId: payments.loanId,
      scheduleItemId: paymentAllocations.scheduleItemId,
      bucket: paymentAllocations.bucket,
      amountKobo: sql<string>`SUM(${paymentAllocations.amountKobo})::text`,
    })
    .from(paymentAllocations)
    .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
    .where(
      and(
        inArray(payments.loanId, loanIds),
        notExists(tx.select({ id: correction.id }).from(correction).where(eq(correction.reversesPaymentId, payments.id))),
      ),
    )
    .groupBy(payments.loanId, paymentAllocations.scheduleItemId, paymentAllocations.bucket);

  const charged = await tx
    .select({
      scheduleItemId: penaltyCharges.scheduleItemId,
      amountKobo: sql<string>`SUM(${penaltyCharges.amountKobo})::text`,
    })
    .from(penaltyCharges)
    .where(inArray(penaltyCharges.loanId, loanIds))
    .groupBy(penaltyCharges.scheduleItemId);
  const waived = await tx
    .select({
      scheduleItemId: penaltyWaivers.scheduleItemId,
      amountKobo: sql<string>`SUM(${penaltyWaivers.amountKobo})::text`,
    })
    .from(penaltyWaivers)
    .where(inArray(penaltyWaivers.loanId, loanIds))
    .groupBy(penaltyWaivers.scheduleItemId);

  const paidByItem = new Map(paid.map((row) => [`${row.scheduleItemId}:${row.bucket}`, BigInt(row.amountKobo)]));
  const chargedByItem = new Map(charged.map((row) => [row.scheduleItemId, BigInt(row.amountKobo)]));
  const waivedByItem = new Map(waived.map((row) => [row.scheduleItemId, BigInt(row.amountKobo)]));
  const paidOf = (itemId: string, bucket: string) => paidByItem.get(`${itemId}:${bucket}`) ?? 0n;

  for (const loanId of loanIds) {
    let principal = 0n;
    let interest = 0n;
    let fee = 0n;
    let penalty = 0n;
    let overdue = 0n;
    let totalPaid = 0n;
    const open: OpenInstallment[] = [];
    const itemIds: string[] = [];

    const installments: LoanInstallment[] = items
      .filter((item) => item.loanId === loanId)
      .map((item) => {
        const penaltyPaid = paidOf(item.id, 'penalty');
        const remaining = {
          penalty: (chargedByItem.get(item.id) ?? 0n) - (waivedByItem.get(item.id) ?? 0n) - penaltyPaid,
          fee: item.feeKobo - paidOf(item.id, 'fee'),
          interest: item.interestKobo - paidOf(item.id, 'interest'),
          principal: item.principalKobo - paidOf(item.id, 'principal'),
        };
        const scheduledLeft = remaining.fee + remaining.interest + remaining.principal;
        const left = scheduledLeft + remaining.penalty;
        const paidKobo = item.totalKobo - scheduledLeft;

        principal += remaining.principal;
        interest += remaining.interest;
        fee += remaining.fee;
        penalty += remaining.penalty;
        totalPaid += paidKobo + penaltyPaid;
        itemIds.push(item.id);
        if (left > 0n) open.push({ id: item.id, remaining });

        const isOverdue = left > 0n && item.dueDate < today;
        if (isOverdue) overdue += left;
        let status: InstallmentStatus = 'due';
        if (left === 0n) status = 'paid';
        else if (isOverdue) status = 'overdue';
        else if (paidKobo > 0n) status = 'part_paid';

        return {
          number: item.number,
          dueDate: item.dueDate,
          principalKobo: item.principalKobo.toString(),
          interestKobo: item.interestKobo.toString(),
          feeKobo: item.feeKobo.toString(),
          totalKobo: item.totalKobo.toString(),
          balanceAfterKobo: item.balanceAfterKobo.toString(),
          paidKobo: paidKobo.toString(),
          penaltyOwedKobo: remaining.penalty.toString(),
          status,
        };
      });

    const overpayment = BigInt(
      paid.find((row) => row.loanId === loanId && row.bucket === 'overpayment')?.amountKobo ?? 0,
    );
    const total = principal + interest + fee + penalty;
    positions.set(loanId, {
      open,
      installments,
      itemIds,
      outstandingTotal: total,
      outstanding: {
        principalKobo: principal.toString(),
        interestKobo: interest.toString(),
        feeKobo: fee.toString(),
        penaltyKobo: penalty.toString(),
        totalKobo: total.toString(),
        overdueKobo: overdue.toString(),
        paidKobo: (totalPaid + overpayment).toString(),
        overpaymentKobo: overpayment.toString(),
      },
    });
  }
  return positions;
}

export async function loanPosition(tx: Tx, loanId: string): Promise<LoanPosition> {
  return (await loanPositions(tx, [loanId])).get(loanId)!;
}
