import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type {
  AllocationBucket,
  JournalLineInput,
  LoanStatement,
  PaymentDetail,
  PaymentSummary,
  RecordPaymentRequest,
  ReversePaymentRequest,
  StatementLine,
} from '@loan-platform/api-client';
import { PG_UNIQUE_VIOLATION, pgError } from '../../common/errors.js';
import { nextReference } from '../../common/references.js';
import type { AuthContext } from '../../common/request-context.js';
import { DatabaseService, type Tx } from '../../db/database.service.js';
import {
  borrowers,
  loans,
  paymentAllocations,
  payments,
  penaltyCharges,
  penaltyWaivers,
  scheduleItems,
  users,
} from '../../db/schema.js';
import { AuditService } from '../audit/audit.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { allocatePayment } from './allocation.js';
import { loanPosition, tenantToday } from './position.js';

const CASH_ACCOUNT = { cash: '1000', bank: '1010' } as const;
/** Income is recognised when paid, so each share of a payment goes straight to these accounts. */
const BUCKET_ACCOUNT: Record<AllocationBucket | 'overpayment', string> = {
  principal: '1100',
  interest: '4000',
  fee: '4010',
  penalty: '4020',
  overpayment: '2000',
};

const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

@Injectable()
export class RepaymentsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  /**
   * The loan row lock runs repayments on one loan strictly one at a time, so two staff recording
   * together always allocate against the true balance. A retried request returns the first result.
   */
  record(auth: AuthContext, loanId: string, key: string, input: RecordPaymentRequest): Promise<PaymentDetail> {
    return this.translated(() =>
      this.database.withTenant(auth.tenantId, async (tx) => {
        const [loan] = await tx.select().from(loans).where(eq(loans.id, loanId)).for('update');
        if (!loan) throw new NotFoundException('Loan not found');

        const requestHash = hashOf([loanId, input.amountKobo, input.paymentDate, input.method, input.reference ?? null]);
        const replay = await this.findReplay(tx, key, requestHash);
        if (replay) return replay;

        if (loan.status !== 'active') {
          throw new ConflictException(`Repayments can only be recorded on an active loan. ${loan.reference} is ${loan.status}.`);
        }
        const today = await tenantToday(tx);
        if (input.paymentDate > today) throw new UnprocessableEntityException('Payment date cannot be in the future');
        if (input.paymentDate < loan.disbursementDate!) {
          throw new UnprocessableEntityException('Payment date cannot be before the loan was paid out');
        }

        const before = await loanPosition(tx, loanId);
        const amount = BigInt(input.amountKobo);
        const allocations = allocatePayment(amount, before.open, loan.terms.allocationOrder);

        const reference = await nextReference(tx, auth.tenantId, 'R');
        const totals = new Map<string, bigint>();
        for (const { bucket, amountKobo } of allocations) {
          const account = BUCKET_ACCOUNT[bucket];
          totals.set(account, (totals.get(account) ?? 0n) + amountKobo);
        }
        const lines: JournalLineInput[] = [
          { accountCode: CASH_ACCOUNT[input.method], side: 'debit', amountKobo: input.amountKobo },
          ...[...totals].map(([accountCode, total]) => ({
            accountCode,
            side: 'credit' as const,
            amountKobo: total.toString(),
          })),
        ];
        const entry = await this.ledger.post(tx, auth, {
          idempotencyKey: `payment:${auth.tenantId}:${reference}`,
          effectiveDate: input.paymentDate,
          description: `Repayment ${reference} on loan ${loan.reference}`,
          sourceType: 'payment',
          sourceId: reference,
          lines,
        });

        const balanceAfter = before.outstandingTotal - amount;
        const [payment] = await tx
          .insert(payments)
          .values({
            tenantId: auth.tenantId,
            reference,
            loanId,
            amountKobo: amount,
            paymentDate: input.paymentDate,
            method: input.method,
            externalReference: input.reference,
            note: input.note,
            idempotencyKey: key,
            requestHash,
            balanceAfterKobo: balanceAfter,
            journalEntryId: entry.id,
            recordedByUserId: auth.userId,
          })
          .returning({ id: payments.id });
        await tx.insert(paymentAllocations).values(
          allocations.map((allocation) => ({
            tenantId: auth.tenantId,
            paymentId: payment!.id,
            scheduleItemId: allocation.scheduleItemId,
            bucket: allocation.bucket,
            amountKobo: allocation.amountKobo,
          })),
        );

        if (balanceAfter <= 0n) {
          await tx.update(loans).set({ status: 'closed', updatedAt: sql`now()` }).where(eq(loans.id, loanId));
          await this.audit.record(tx, auth, { action: 'loan.closed', entityType: 'loan', entityId: loanId });
        }
        await this.audit.record(tx, auth, {
          action: 'payment.recorded',
          entityType: 'payment',
          entityId: payment!.id,
          metadata: { reference, amountKobo: input.amountKobo, loan: loan.reference },
        });
        return this.load(tx, payment!.id);
      }),
    );
  }

  /**
   * Corrects the latest payment on a loan. Later payments were allocated on top of earlier ones,
   * so corrections run newest first. Someone other than the recorder must do it, which stops one
   * person taking a repayment and quietly removing the record.
   */
  reverse(auth: AuthContext, paymentId: string, key: string, input: ReversePaymentRequest): Promise<PaymentDetail> {
    return this.translated(() =>
      this.database.withTenant(auth.tenantId, async (tx) => {
        const [found] = await tx.select().from(payments).where(eq(payments.id, paymentId));
        if (!found) throw new NotFoundException('Payment not found');
        const [loan] = await tx.select().from(loans).where(eq(loans.id, found.loanId)).for('update');

        const requestHash = hashOf(['reverse', paymentId]);
        const replay = await this.findReplay(tx, key, requestHash);
        if (replay) return replay;

        if (found.reversesPaymentId) throw new UnprocessableEntityException('A correction cannot itself be corrected');
        if (found.isOpening) throw new UnprocessableEntityException('The amount paid before moving to this system cannot be corrected here');
        if (found.recordedByUserId === auth.userId) {
          throw new ForbiddenException('The person who recorded a payment cannot correct it');
        }
        const correction = alias(payments, 'correction');
        const [reversed] = await tx
          .select({ id: correction.id })
          .from(correction)
          .where(eq(correction.reversesPaymentId, paymentId));
        if (reversed) throw new ConflictException('This payment has already been corrected');

        const original = alias(payments, 'original');
        const [later] = await tx
          .select({ reference: payments.reference })
          .from(payments)
          .leftJoin(original, eq(original.reversesPaymentId, payments.id))
          .where(
            and(
              eq(payments.loanId, found.loanId),
              isNull(payments.reversesPaymentId),
              isNull(original.id),
              // Compared in SQL because a JavaScript Date would drop the microseconds.
              gt(payments.createdAt, sql`(SELECT p.created_at FROM payments p WHERE p.id = ${paymentId})`),
            ),
          )
          .limit(1);
        if (later) {
          throw new ConflictException(`Correct the later payment ${later.reference} first`);
        }

        const today = await tenantToday(tx);
        const reference = await nextReference(tx, auth.tenantId, 'RV');
        const entry = await this.ledger.reverseWithin(tx, auth, found.journalEntryId, `payment-reversal:${paymentId}`, {
          effectiveDate: today,
          reason: `${found.reference}: ${input.reason}`,
        });

        const before = await loanPosition(tx, found.loanId);
        const refunded = await this.allocatedTo(tx, paymentId);
        const balanceAfter = before.outstandingTotal + refunded;
        const [row] = await tx
          .insert(payments)
          .values({
            tenantId: auth.tenantId,
            reference,
            loanId: found.loanId,
            amountKobo: found.amountKobo,
            paymentDate: today,
            method: found.method,
            note: input.reason,
            idempotencyKey: key,
            requestHash,
            reversesPaymentId: paymentId,
            balanceAfterKobo: balanceAfter,
            journalEntryId: entry.id,
            recordedByUserId: auth.userId,
          })
          .returning({ id: payments.id });

        if (loan!.status === 'closed' && balanceAfter > 0n) {
          await tx.update(loans).set({ status: 'active', updatedAt: sql`now()` }).where(eq(loans.id, found.loanId));
          await this.audit.record(tx, auth, { action: 'loan.reopened', entityType: 'loan', entityId: found.loanId });
        }
        await this.audit.record(tx, auth, {
          action: 'payment.reversed',
          entityType: 'payment',
          entityId: paymentId,
          metadata: { reference: found.reference, correction: reference, reason: input.reason },
        });
        return this.load(tx, row!.id);
      }),
    );
  }

  /** Amount of a payment that had reduced the schedule, leaving out any overpayment. */
  private async allocatedTo(tx: Tx, paymentId: string): Promise<bigint> {
    const rows = await tx
      .select({ bucket: paymentAllocations.bucket, amountKobo: paymentAllocations.amountKobo })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, paymentId));
    return rows.reduce((sum, row) => (row.bucket === 'overpayment' ? sum : sum + row.amountKobo), 0n);
  }

  private async findReplay(tx: Tx, key: string, requestHash: string): Promise<PaymentDetail | null> {
    const [existing] = await tx
      .select({ id: payments.id, requestHash: payments.requestHash })
      .from(payments)
      .where(eq(payments.idempotencyKey, key));
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw new ConflictException('This idempotency key was already used for a different payment');
    }
    return this.load(tx, existing.id);
  }

  async listForLoan(tx: Tx, loanId: string): Promise<PaymentSummary[]> {
    return this.summaries(tx, eq(payments.loanId, loanId), 500);
  }

  list(auth: AuthContext): Promise<PaymentSummary[]> {
    return this.database.withTenant(auth.tenantId, (tx) => this.summaries(tx, undefined, 200));
  }

  private async summaries(tx: Tx, where: ReturnType<typeof eq> | undefined, limit: number): Promise<PaymentSummary[]> {
    const correction = alias(payments, 'correction');
    const rows = await tx
      .select({
        payment: payments,
        loanReference: loans.reference,
        borrowerName: borrowers.fullName,
        reversedByPaymentId: correction.id,
      })
      .from(payments)
      .innerJoin(loans, eq(loans.id, payments.loanId))
      .innerJoin(borrowers, eq(borrowers.id, loans.borrowerId))
      .leftJoin(correction, eq(correction.reversesPaymentId, payments.id))
      .where(where)
      .orderBy(desc(payments.createdAt))
      .limit(limit);
    return rows.map(({ payment, ...row }) => ({
      id: payment.id,
      reference: payment.reference,
      loanId: payment.loanId,
      loanReference: row.loanReference,
      borrowerName: row.borrowerName,
      amountKobo: payment.amountKobo.toString(),
      paymentDate: payment.paymentDate,
      method: payment.method,
      isOpening: payment.isOpening,
      reversesPaymentId: payment.reversesPaymentId,
      reversedByPaymentId: row.reversedByPaymentId,
    }));
  }

  get(auth: AuthContext, id: string): Promise<PaymentDetail> {
    return this.database.withTenant(auth.tenantId, (tx) => this.load(tx, id));
  }

  private async load(tx: Tx, id: string): Promise<PaymentDetail> {
    const [summary] = await this.summaries(tx, eq(payments.id, id), 1);
    if (!summary) throw new NotFoundException('Payment not found');
    const [row] = await tx
      .select({ payment: payments, recordedByName: users.fullName })
      .from(payments)
      .innerJoin(users, eq(users.id, payments.recordedByUserId))
      .where(eq(payments.id, id));
    const allocations = await tx
      .select({ bucket: paymentAllocations.bucket, amountKobo: paymentAllocations.amountKobo })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, summary.reversesPaymentId ?? id));
    const total = (bucket: string) =>
      allocations.filter((item) => item.bucket === bucket).reduce((sum, item) => sum + item.amountKobo, 0n).toString();
    return {
      ...summary,
      externalReference: row!.payment.externalReference,
      note: row!.payment.note,
      recordedByUserId: row!.payment.recordedByUserId,
      recordedByName: row!.recordedByName,
      recordedAt: row!.payment.createdAt.toISOString(),
      allocation: {
        principalKobo: total('principal'),
        interestKobo: total('interest'),
        feeKobo: total('fee'),
        penaltyKobo: total('penalty'),
        overpaymentKobo: total('overpayment'),
      },
      balanceAfterKobo: row!.payment.balanceAfterKobo.toString(),
      journalEntryId: row!.payment.journalEntryId,
    };
  }

  /** Runs oldest to newest by date. A corrected payment and its correction both stay visible. */
  statement(auth: AuthContext, loanId: string): Promise<LoanStatement> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const [row] = await tx
        .select({ loan: loans, borrowerName: borrowers.fullName, borrowerReference: borrowers.reference })
        .from(loans)
        .innerJoin(borrowers, eq(borrowers.id, loans.borrowerId))
        .where(eq(loans.id, loanId));
      if (!row) throw new NotFoundException('Loan not found');
      if (!row.loan.disbursementDate) throw new ConflictException('This loan has not been paid out yet');

      const [{ owed } = { owed: '0' }] = await tx
        .select({ owed: sql<string>`COALESCE(SUM(${scheduleItems.totalKobo}), 0)::text` })
        .from(scheduleItems)
        .where(eq(scheduleItems.loanId, loanId));
      const history = await tx.select().from(payments).where(eq(payments.loanId, loanId));
      const charges = await tx
        .select({
          date: penaltyCharges.chargeDate,
          amountKobo: sql<string>`SUM(${penaltyCharges.amountKobo})::text`,
          createdAt: sql<string>`MIN(${penaltyCharges.createdAt})::text`,
        })
        .from(penaltyCharges)
        .where(eq(penaltyCharges.loanId, loanId))
        .groupBy(penaltyCharges.chargeDate);
      const waivers = await tx
        .select({
          date: penaltyWaivers.waivedOn,
          reason: penaltyWaivers.reason,
          amountKobo: sql<string>`SUM(${penaltyWaivers.amountKobo})::text`,
          createdAt: sql<string>`MIN(${penaltyWaivers.createdAt})::text`,
        })
        .from(penaltyWaivers)
        .where(eq(penaltyWaivers.loanId, loanId))
        .groupBy(penaltyWaivers.waivedOn, penaltyWaivers.reason);

      const events: {
        date: string;
        order: string;
        description: string;
        reference: string | null;
        charged: bigint;
        paid: bigint;
      }[] = [
        ...history.map((payment) => {
          const correcting = payment.reversesPaymentId !== null;
          return {
            date: payment.paymentDate,
            order: payment.createdAt.toISOString(),
            description: correcting
              ? `Correction: ${payment.note}`
              : payment.isOpening
                ? 'Paid before moving to this system'
                : 'Repayment received',
            reference: payment.reference,
            charged: correcting ? payment.amountKobo : 0n,
            paid: correcting ? 0n : payment.amountKobo,
          };
        }),
        ...charges.map((charge) => ({
          date: charge.date,
          order: charge.createdAt,
          description: 'Late penalty',
          reference: null,
          charged: BigInt(charge.amountKobo),
          paid: 0n,
        })),
        ...waivers.map((waiver) => ({
          date: waiver.date,
          order: waiver.createdAt,
          description: `Penalty waived: ${waiver.reason}`,
          reference: null,
          charged: 0n,
          paid: BigInt(waiver.amountKobo),
        })),
      ];
      events.sort((a, b) => a.date.localeCompare(b.date) || a.order.localeCompare(b.order));

      let balance = BigInt(owed);
      const lines: StatementLine[] = [
        {
          date: row.loan.disbursementDate,
          description: 'Loan paid out: amount to repay, including interest and fees',
          reference: row.loan.reference,
          chargedKobo: owed,
          paidKobo: '0',
          balanceKobo: owed,
        },
      ];
      for (const event of events) {
        balance += event.charged - event.paid;
        lines.push({
          date: event.date,
          description: event.description,
          reference: event.reference,
          chargedKobo: event.charged.toString(),
          paidKobo: event.paid.toString(),
          balanceKobo: balance.toString(),
        });
      }
      return {
        loanReference: row.loan.reference,
        borrowerName: row.borrowerName,
        borrowerReference: row.borrowerReference,
        principalKobo: row.loan.principalKobo.toString(),
        lines,
        closingBalanceKobo: balance.toString(),
        generatedOn: await tenantToday(tx),
      };
    });
  }

  private async translated<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (pgError(error).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException('This payment was changed by someone else. Refresh and try again.');
      }
      throw error;
    }
  }
}
