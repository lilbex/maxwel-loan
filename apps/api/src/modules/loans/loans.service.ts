import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DisburseRequest, JournalLineInput, Loan, LoanSummary, OpeningSummary } from '@loan-platform/api-client';
import type { AuthContext } from '../../common/request-context.js';
import { DatabaseService, type Tx } from '../../db/database.service.js';
import { borrowers, journalLines, loanApplications, loans, payments, scheduleItems, tenants, users } from '../../db/schema.js';
import { AuditService } from '../audit/audit.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { buildSchedule, ScheduleError } from '../loan-products/schedule.js';
import { CollectionsService } from './collections.service.js';
import { loanPosition, tenantToday } from './position.js';
import { RepaymentsService } from './repayments.service.js';

const CASH_ACCOUNT = { cash: '1000', bank: '1010' } as const;
const LOANS_RECEIVABLE = '1100';
const FEE_INCOME = '4010';

@Injectable()
export class LoansService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(RepaymentsService) private readonly repayments: RepaymentsService,
    @Inject(CollectionsService) private readonly collections: CollectionsService,
  ) {}

  list(auth: AuthContext, filter: { borrowerId?: string }): Promise<LoanSummary[]> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx
        .select({ loan: loans, borrowerName: borrowers.fullName })
        .from(loans)
        .innerJoin(borrowers, eq(borrowers.id, loans.borrowerId))
        .where(and(filter.borrowerId ? eq(loans.borrowerId, filter.borrowerId) : undefined))
        .orderBy(desc(loans.approvedAt))
        .limit(200);
      return rows.map(({ loan, borrowerName }) => this.toSummary(loan, borrowerName));
    });
  }

  private toSummary(loan: typeof loans.$inferSelect, borrowerName: string): LoanSummary {
    return {
      id: loan.id,
      reference: loan.reference,
      origin: loan.origin,
      status: loan.status,
      borrowerId: loan.borrowerId,
      borrowerName,
      productName: loan.terms.name,
      principalKobo: loan.principalKobo.toString(),
      termCount: loan.termCount,
      disbursementDate: loan.disbursementDate,
    };
  }

  get(auth: AuthContext, id: string): Promise<Loan> {
    return this.database.withTenant(auth.tenantId, (tx) => this.load(tx, id));
  }

  private async load(tx: Tx, id: string): Promise<Loan> {
    const [row] = await tx
      .select({ loan: loans, borrowerName: borrowers.fullName, approvedByName: users.fullName })
      .from(loans)
      .innerJoin(borrowers, eq(borrowers.id, loans.borrowerId))
      .innerJoin(users, eq(users.id, loans.approvedByUserId))
      .where(eq(loans.id, id));
    if (!row) throw new NotFoundException('Loan not found');
    const { loan } = row;
    const position = await loanPosition(tx, id);
    return {
      ...this.toSummary(loan, row.borrowerName),
      applicationId: loan.applicationId,
      terms: loan.terms,
      approvedByName: row.approvedByName,
      approvedAt: loan.approvedAt.toISOString(),
      disbursementMethod: loan.disbursementMethod,
      disbursementReference: loan.disbursementReference,
      disbursementEntryId: loan.disbursementEntryId,
      installments: position.installments,
      outstanding: position.outstanding,
      payments: await this.repayments.listForLoan(tx, id),
      notes: await this.collections.notesFor(tx, id),
    };
  }

  /**
   * Records money already paid out. The loan row lock makes a double click or retry fail with
   * 409 rather than pay twice, and the schedule, journal entry and status commit together.
   *
   * This posts principal and upfront fees only. Interest and scheduled fees are not income
   * until they fall due or are paid, which steps 5 and 6 handle.
   */
  disburse(auth: AuthContext, id: string, input: DisburseRequest): Promise<Loan> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const [loan] = await tx.select().from(loans).where(eq(loans.id, id)).for('update');
      if (!loan) throw new NotFoundException('Loan not found');
      if (loan.status !== 'approved') throw new ConflictException(`Loan ${loan.reference} is already ${loan.status}`);

      const [tenant] = await tx
        .select({ today: sql<string>`(now() AT TIME ZONE ${tenants.timezone})::date::text` })
        .from(tenants);
      if (input.disbursementDate > tenant!.today) {
        throw new UnprocessableEntityException('Disbursement date cannot be in the future');
      }

      let schedule;
      try {
        schedule = buildSchedule(loan.terms, {
          principalKobo: loan.principalKobo,
          termCount: loan.termCount,
          disbursementDate: input.disbursementDate,
          firstDueDate: input.firstDueDate,
        });
      } catch (error) {
        if (error instanceof ScheduleError) throw new UnprocessableEntityException(error.message);
        throw error;
      }

      const lines: JournalLineInput[] = [
        { accountCode: LOANS_RECEIVABLE, side: 'debit', amountKobo: loan.principalKobo.toString() },
        { accountCode: CASH_ACCOUNT[input.method], side: 'credit', amountKobo: schedule.netDisbursedKobo },
      ];
      if (schedule.upfrontFeesKobo !== '0') {
        lines.push({ accountCode: FEE_INCOME, side: 'credit', amountKobo: schedule.upfrontFeesKobo });
      }
      const entry = await this.ledger.post(tx, auth, {
        idempotencyKey: `loan-disbursement:${loan.id}`,
        effectiveDate: input.disbursementDate,
        description: `Disbursement of loan ${loan.reference}`,
        sourceType: 'loan',
        sourceId: loan.id,
        lines,
      });

      await tx.insert(scheduleItems).values(
        schedule.installments.map((item) => ({
          tenantId: auth.tenantId,
          loanId: loan.id,
          number: item.number,
          dueDate: item.dueDate,
          principalKobo: BigInt(item.principalKobo),
          interestKobo: BigInt(item.interestKobo),
          feeKobo: BigInt(item.feeKobo),
          totalKobo: BigInt(item.totalKobo),
          balanceAfterKobo: BigInt(item.balanceAfterKobo),
        })),
      );
      await tx
        .update(loans)
        .set({
          status: 'active',
          disbursementDate: input.disbursementDate,
          disbursementMethod: input.method,
          disbursementReference: input.reference,
          disbursedByUserId: auth.userId,
          disbursementEntryId: entry.id,
          updatedAt: sql`now()`,
        })
        .where(eq(loans.id, id));
      await this.audit.record(tx, auth, {
        action: 'loan.disbursed',
        entityType: 'loan',
        entityId: id,
        metadata: { netDisbursedKobo: schedule.netDisbursedKobo, method: input.method },
      });
      return this.load(tx, id);
    });
  }

  /** The sign-off sheet: every loan moved from paper, to compare with a count of the records. */
  openingSummary(auth: AuthContext): Promise<OpeningSummary> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const today = await tenantToday(tx);
      const moved = await tx
        .select({ loan: loans, borrowerName: borrowers.fullName })
        .from(loans)
        .innerJoin(borrowers, eq(borrowers.id, loans.borrowerId))
        .where(eq(loans.origin, 'existing'))
        .orderBy(asc(loans.reference));

      const entries = await tx
        .select({ id: journalLines.entryId, amountKobo: journalLines.amountKobo })
        .from(journalLines)
        .where(eq(journalLines.side, 'debit'));
      const principalByEntry = new Map(entries.map((row) => [row.id, row.amountKobo]));
      const totals = await tx
        .select({ loanId: scheduleItems.loanId, total: sql<string>`SUM(${scheduleItems.totalKobo})::text` })
        .from(scheduleItems)
        .groupBy(scheduleItems.loanId);
      const totalByLoan = new Map(totals.map((row) => [row.loanId, BigInt(row.total)]));
      const opening = await tx
        .select({ loanId: payments.loanId, amountKobo: payments.amountKobo })
        .from(payments)
        .where(eq(payments.isOpening, true));
      const paidByLoan = new Map(opening.map((row) => [row.loanId, row.amountKobo]));

      let owed = 0n;
      let principal = 0n;
      const rows = moved.map(({ loan, borrowerName }) => {
        const paid = paidByLoan.get(loan.id) ?? 0n;
        const owedAtMove = (totalByLoan.get(loan.id) ?? 0n) - paid;
        const principalAtMove = principalByEntry.get(loan.disbursementEntryId!) ?? 0n;
        owed += owedAtMove;
        principal += principalAtMove;
        return {
          loanId: loan.id,
          loanReference: loan.reference,
          borrowerName,
          principalKobo: loan.principalKobo.toString(),
          paidBeforeKobo: paid.toString(),
          owedAtMoveKobo: owedAtMove.toString(),
          principalAtMoveKobo: principalAtMove.toString(),
        };
      });

      const waiting = await tx
        .select({ status: loanApplications.status, count: sql<number>`COUNT(*)::int` })
        .from(loanApplications)
        .where(eq(loanApplications.kind, 'existing'))
        .groupBy(loanApplications.status);
      const countOf = (status: string) => waiting.find((row) => row.status === status)?.count ?? 0;

      return {
        today,
        rows,
        loansMoved: rows.length,
        totalOwedKobo: owed.toString(),
        totalPrincipalKobo: principal.toString(),
        drafts: countOf('draft'),
        waitingForCheck: countOf('submitted'),
      };
    });
  }

  cancel(auth: AuthContext, id: string): Promise<Loan> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const [loan] = await tx.select().from(loans).where(eq(loans.id, id)).for('update');
      if (!loan) throw new NotFoundException('Loan not found');
      if (loan.status !== 'approved') throw new ConflictException('Only an undisbursed loan can be cancelled');
      await tx.update(loans).set({ status: 'cancelled', updatedAt: sql`now()` }).where(eq(loans.id, id));
      await this.audit.record(tx, auth, { action: 'loan.cancelled', entityType: 'loan', entityId: id });
      return this.load(tx, id);
    });
  }
}
