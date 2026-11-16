import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, desc, eq, inArray, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type {
  CollectionNote,
  CollectionNoteRequest,
  CollectionRow,
  CollectionsReport,
  PenaltyRunResult,
  WaivePenaltyRequest,
} from '@loan-platform/api-client';
import type { AuthContext } from '../../common/request-context.js';
import { DatabaseService, type Tx } from '../../db/database.service.js';
import {
  borrowers,
  collectionNotes,
  loans,
  paymentAllocations,
  payments,
  penaltyCharges,
  penaltyWaivers,
  scheduleItems,
  users,
} from '../../db/schema.js';
import { AuditService } from '../audit/audit.service.js';
import { expectedPenalties } from './penalties.js';
import { loanPosition, loanPositions, tenantToday } from './position.js';

const AGEING = [
  { label: '1 to 30 days', from: 1, to: 30 },
  { label: '31 to 60 days', from: 31, to: 60 },
  { label: '61 to 90 days', from: 61, to: 90 },
  { label: 'Over 90 days', from: 91, to: Number.POSITIVE_INFINITY },
];

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

@Injectable()
export class CollectionsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async applyForAllTenants(): Promise<PenaltyRunResult> {
    const total: PenaltyRunResult = { loansCharged: 0, chargesAdded: 0 };
    for (const tenantId of await this.database.activeTenantIds()) {
      const result = await this.applyForTenant(tenantId);
      total.loansCharged += result.loansCharged;
      total.chargesAdded += result.chargesAdded;
    }
    return total;
  }

  /** Safe to run any number of times. Each loan gets its own transaction, so one failure stays small. */
  async applyForTenant(tenantId: string, asOf?: string): Promise<PenaltyRunResult> {
    const loanIds = await this.database.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({ id: loans.id })
        .from(loans)
        .where(and(eq(loans.status, 'active'), ne(sql`${loans.terms}->'penalty'->>'type'`, 'none')));
      return rows.map((row) => row.id);
    });

    const result: PenaltyRunResult = { loansCharged: 0, chargesAdded: 0 };
    for (const loanId of loanIds) {
      const added = await this.database.withTenant(tenantId, (tx) => this.applyToLoan(tx, tenantId, loanId, asOf));
      if (added > 0) {
        result.loansCharged += 1;
        result.chargesAdded += added;
      }
    }
    return result;
  }

  private async applyToLoan(tx: Tx, tenantId: string, loanId: string, asOf?: string): Promise<number> {
    const [loan] = await tx.select().from(loans).where(eq(loans.id, loanId)).for('update');
    if (loan?.status !== 'active') return 0;

    const items = await tx.select().from(scheduleItems).where(eq(scheduleItems.loanId, loanId));
    const correction = alias(payments, 'correction');
    const paid = await tx
      .select({
        scheduleItemId: paymentAllocations.scheduleItemId,
        paymentDate: payments.paymentDate,
        amountKobo: paymentAllocations.amountKobo,
      })
      .from(paymentAllocations)
      .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
      .where(
        and(
          eq(payments.loanId, loanId),
          inArray(paymentAllocations.bucket, ['fee', 'interest', 'principal']),
          notExists(tx.select({ id: correction.id }).from(correction).where(eq(correction.reversesPaymentId, payments.id))),
        ),
      );

    const charges = expectedPenalties(
      loan.terms.penalty,
      items.map((item) => ({ id: item.id, dueDate: item.dueDate, totalKobo: item.totalKobo })),
      paid.map((row) => ({ ...row, scheduleItemId: row.scheduleItemId! })),
      asOf ?? (await tenantToday(tx)),
      loan.penaltiesAfter ?? undefined,
    );
    if (charges.length === 0) return 0;

    const inserted = await tx
      .insert(penaltyCharges)
      .values(charges.map((charge) => ({ ...charge, tenantId, loanId })))
      .onConflictDoNothing({
        target: [penaltyCharges.tenantId, penaltyCharges.scheduleItemId, penaltyCharges.chargeDate],
      })
      .returning({ amountKobo: penaltyCharges.amountKobo });

    if (inserted.length > 0) {
      await this.audit.record(
        tx,
        { tenantId, userId: null, ipAddress: null, userAgent: null },
        {
          action: 'penalty.charged',
          entityType: 'loan',
          entityId: loanId,
          metadata: {
            charges: inserted.length,
            totalKobo: inserted.reduce((sum, row) => sum + row.amountKobo, 0n).toString(),
          },
        },
      );
    }
    return inserted.length;
  }

  applyNow(auth: AuthContext): Promise<PenaltyRunResult> {
    return this.applyForTenant(auth.tenantId);
  }

  /** Clears unpaid penalties oldest first. Nothing reaches the ledger, because nothing was counted as income. */
  waive(auth: AuthContext, loanId: string, input: WaivePenaltyRequest): Promise<void> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const [loan] = await tx.select().from(loans).where(eq(loans.id, loanId)).for('update');
      if (!loan) throw new NotFoundException('Loan not found');
      const position = await loanPosition(tx, loanId);

      let left = BigInt(input.amountKobo);
      if (left > BigInt(position.outstanding.penaltyKobo)) {
        throw new UnprocessableEntityException('This is more than the penalties owed on this loan');
      }
      const today = await tenantToday(tx);
      for (const item of position.open) {
        if (left === 0n) break;
        const amount = item.remaining.penalty < left ? item.remaining.penalty : left;
        if (amount <= 0n) continue;
        await tx.insert(penaltyWaivers).values({
          tenantId: auth.tenantId,
          loanId,
          scheduleItemId: item.id,
          amountKobo: amount,
          waivedOn: today,
          reason: input.reason,
          waivedByUserId: auth.userId,
        });
        left -= amount;
      }
      if (position.outstandingTotal === BigInt(input.amountKobo)) {
        await tx.update(loans).set({ status: 'closed', updatedAt: sql`now()` }).where(eq(loans.id, loanId));
        await this.audit.record(tx, auth, { action: 'loan.closed', entityType: 'loan', entityId: loanId });
      }
      await this.audit.record(tx, auth, {
        action: 'penalty.waived',
        entityType: 'loan',
        entityId: loanId,
        metadata: { amountKobo: input.amountKobo, reason: input.reason },
      });
    });
  }

  addNote(auth: AuthContext, loanId: string, input: CollectionNoteRequest): Promise<CollectionNote> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const [loan] = await tx.select({ id: loans.id }).from(loans).where(eq(loans.id, loanId));
      if (!loan) throw new NotFoundException('Loan not found');
      const [row] = await tx
        .insert(collectionNotes)
        .values({
          tenantId: auth.tenantId,
          loanId,
          outcome: input.outcome,
          note: input.note,
          promisedDate: input.promisedDate,
          promisedAmountKobo: input.promisedAmountKobo ? BigInt(input.promisedAmountKobo) : undefined,
          recordedByUserId: auth.userId,
        })
        .returning({ id: collectionNotes.id });
      await this.audit.record(tx, auth, {
        action: 'collection.noted',
        entityType: 'loan',
        entityId: loanId,
        metadata: { outcome: input.outcome },
      });
      return (await this.notesFor(tx, loanId)).find((note) => note.id === row!.id)!;
    });
  }

  async notesFor(tx: Tx, loanId: string): Promise<CollectionNote[]> {
    const rows = await tx
      .select({ note: collectionNotes, recordedByName: users.fullName })
      .from(collectionNotes)
      .innerJoin(users, eq(users.id, collectionNotes.recordedByUserId))
      .where(eq(collectionNotes.loanId, loanId))
      .orderBy(desc(collectionNotes.createdAt))
      .limit(100);
    return rows.map(({ note, recordedByName }) => ({
      id: note.id,
      outcome: note.outcome,
      note: note.note,
      promisedDate: note.promisedDate,
      promisedAmountKobo: note.promisedAmountKobo?.toString() ?? null,
      recordedByName,
      createdAt: note.createdAt.toISOString(),
    }));
  }

  report(auth: AuthContext): Promise<CollectionsReport> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const today = await tenantToday(tx);
      const active = await tx
        .select({
          id: loans.id,
          reference: loans.reference,
          borrowerId: borrowers.id,
          borrowerName: borrowers.fullName,
          borrowerPhone: borrowers.phone,
        })
        .from(loans)
        .innerJoin(borrowers, eq(borrowers.id, loans.borrowerId))
        .where(eq(loans.status, 'active'));
      const positions = await loanPositions(tx, active.map((loan) => loan.id));

      const latestNotes = await tx
        .selectDistinctOn([collectionNotes.loanId], {
          loanId: collectionNotes.loanId,
          note: collectionNotes.note,
          promisedDate: collectionNotes.promisedDate,
        })
        .from(collectionNotes)
        .orderBy(collectionNotes.loanId, desc(collectionNotes.createdAt));
      const noteOf = new Map(latestNotes.map((note) => [note.loanId, note]));

      let dueToday = 0n;
      let overdue = 0n;
      let principalTotal = 0n;
      let principalAtRisk = 0n;
      const ageing = AGEING.map((bucket) => ({ ...bucket, loans: 0, principal: 0n }));
      const rows: CollectionRow[] = [];

      for (const loan of active) {
        const position = positions.get(loan.id)!;
        const principal = BigInt(position.outstanding.principalKobo);
        principalTotal += principal;

        const unpaid = position.installments
          .filter((item) => item.status !== 'paid')
          .map((item) => ({
            dueDate: item.dueDate,
            left: BigInt(item.totalKobo) - BigInt(item.paidKobo) + BigInt(item.penaltyOwedKobo),
          }));
        const todayLeft = unpaid.filter((item) => item.dueDate === today).reduce((sum, item) => sum + item.left, 0n);
        const late = unpaid.filter((item) => item.dueDate < today);
        const next = unpaid.find((item) => item.dueDate >= today);
        const daysOverdue = late[0] ? daysBetween(late[0].dueDate, today) : 0;

        dueToday += todayLeft;
        overdue += BigInt(position.outstanding.overdueKobo);
        if (daysOverdue > 0) {
          const bucket = ageing.find((item) => daysOverdue >= item.from && daysOverdue <= item.to)!;
          bucket.loans += 1;
          bucket.principal += principal;
          if (daysOverdue > 30) principalAtRisk += principal;
        }

        const note = noteOf.get(loan.id);
        rows.push({
          loanId: loan.id,
          loanReference: loan.reference,
          borrowerId: loan.borrowerId,
          borrowerName: loan.borrowerName,
          borrowerPhone: loan.borrowerPhone,
          dueTodayKobo: todayLeft.toString(),
          overdueKobo: position.outstanding.overdueKobo,
          outstandingKobo: position.outstanding.totalKobo,
          daysOverdue,
          nextDueDate: next?.dueDate ?? null,
          nextDueKobo: (next?.left ?? 0n).toString(),
          lastNote: note?.note ?? null,
          promisedDate: note?.promisedDate ?? null,
        });
      }

      rows.sort((a, b) => b.daysOverdue - a.daysOverdue || (a.nextDueDate ?? '').localeCompare(b.nextDueDate ?? ''));
      const par = principalTotal === 0n ? 0n : (principalAtRisk * 10000n + principalTotal / 2n) / principalTotal;

      return {
        today,
        activeLoans: active.length,
        dueTodayKobo: dueToday.toString(),
        overdueKobo: overdue.toString(),
        outstandingPrincipalKobo: principalTotal.toString(),
        principalAtRiskKobo: principalAtRisk.toString(),
        par30Percent: `${par / 100n}.${(par % 100n).toString().padStart(2, '0')}`,
        ageing: ageing.map((bucket) => ({
          label: bucket.label,
          loans: bucket.loans,
          principalKobo: bucket.principal.toString(),
        })),
        rows,
      };
    });
  }
}
