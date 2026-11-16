import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type {
  CollectedDay,
  CollectedReport,
  DisbursementsReport,
  FinancialLine,
  FinancialsReport,
  LoanStatus,
  PortfolioProductRow,
  PortfolioReport,
} from '@loan-platform/api-client';
import type { AuthContext } from '../../common/request-context.js';
import { DatabaseService } from '../../db/database.service.js';
import { borrowers, journalEntries, journalLines, ledgerAccounts, loans, paymentAllocations, payments } from '../../db/schema.js';
import { feeAmount } from '../loan-products/schedule.js';
import { loanPositions, tenantToday } from '../loans/position.js';

const LOANS_RECEIVABLE = '1100';

const percentOf = (part: bigint, whole: bigint) => {
  const basisPoints = whole === 0n ? 0n : (part * 10000n + whole / 2n) / whole;
  return `${basisPoints / 100n}.${(basisPoints % 100n).toString().padStart(2, '0')}`;
};
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

function checkRange(from: string, to: string): void {
  if (from > to) throw new BadRequestException('The start date must not be after the end date');
  if (daysBetween(from, to) > 3660) throw new BadRequestException('Choose a range of 10 years or less');
}

interface Tally {
  receipts: number;
  corrections: number;
  cash: bigint;
  bank: bigint;
  principal: bigint;
  interest: bigint;
  fee: bigint;
  penalty: bigint;
  overpayment: bigint;
}

const emptyTally = (): Tally => ({
  receipts: 0,
  corrections: 0,
  cash: 0n,
  bank: 0n,
  principal: 0n,
  interest: 0n,
  fee: 0n,
  penalty: 0n,
  overpayment: 0n,
});

const fromTally = (tally: Tally): Omit<CollectedDay, 'date'> => ({
  receipts: tally.receipts,
  corrections: tally.corrections,
  cashKobo: tally.cash.toString(),
  bankKobo: tally.bank.toString(),
  principalKobo: tally.principal.toString(),
  interestKobo: tally.interest.toString(),
  feesKobo: tally.fee.toString(),
  penaltiesKobo: tally.penalty.toString(),
  overpaymentsKobo: tally.overpayment.toString(),
  totalKobo: (tally.cash + tally.bank).toString(),
});

@Injectable()
export class ReportsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  portfolio(auth: AuthContext): Promise<PortfolioReport> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const today = await tenantToday(tx);
      const all = await tx.select().from(loans);
      const active = all.filter((loan) => loan.status === 'active');
      const positions = await loanPositions(tx, active.map((loan) => loan.id));

      const counts = new Map<LoanStatus, number>();
      for (const loan of all) counts.set(loan.status, (counts.get(loan.status) ?? 0) + 1);

      const totals = { principal: 0n, interest: 0n, fee: 0n, penalty: 0n, overdue: 0n, atRisk: 0n };
      const byProduct = new Map<string, { loans: number; principal: bigint; atRisk: bigint }>();
      for (const loan of active) {
        const position = positions.get(loan.id)!;
        const { outstanding } = position;
        const principal = BigInt(outstanding.principalKobo);
        const oldestLate = position.installments.find((item) => item.status === 'overdue');
        const atRisk = oldestLate && daysBetween(oldestLate.dueDate, today) > 30 ? principal : 0n;

        totals.principal += principal;
        totals.interest += BigInt(outstanding.interestKobo);
        totals.fee += BigInt(outstanding.feeKobo);
        totals.penalty += BigInt(outstanding.penaltyKobo);
        totals.overdue += BigInt(outstanding.overdueKobo);
        totals.atRisk += atRisk;

        const product = byProduct.get(loan.terms.name) ?? { loans: 0, principal: 0n, atRisk: 0n };
        product.loans += 1;
        product.principal += principal;
        product.atRisk += atRisk;
        byProduct.set(loan.terms.name, product);
      }

      const products: PortfolioProductRow[] = [...byProduct]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([productName, product]) => ({
          productName,
          activeLoans: product.loans,
          principalOutstandingKobo: product.principal.toString(),
          principalOverdueOver30Kobo: product.atRisk.toString(),
          par30Percent: percentOf(product.atRisk, product.principal),
        }));

      const [ledger] = await tx
        .select({
          balance: sql<string>`COALESCE(SUM(CASE WHEN ${journalLines.side} = 'debit' THEN ${journalLines.amountKobo} ELSE -${journalLines.amountKobo} END), 0)::text`,
        })
        .from(journalLines)
        .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
        .where(eq(ledgerAccounts.code, LOANS_RECEIVABLE));

      return {
        asOf: today,
        loansByStatus: [...counts].map(([status, count]) => ({ status, loans: count })),
        totalDisbursedKobo: all
          .filter((loan) => loan.disbursementDate && loan.origin === 'new')
          .reduce((sum, loan) => sum + loan.principalKobo, 0n)
          .toString(),
        principalOutstandingKobo: totals.principal.toString(),
        ledgerPrincipalKobo: ledger!.balance,
        interestOutstandingKobo: totals.interest.toString(),
        feesOutstandingKobo: totals.fee.toString(),
        penaltiesOutstandingKobo: totals.penalty.toString(),
        overdueKobo: totals.overdue.toString(),
        par30Percent: percentOf(totals.atRisk, totals.principal),
        products,
      };
    });
  }

  /**
   * Money received, by the date it landed in the books. A correction counts as a negative on
   * its own date, matching its ledger entry, so every column ties to the ledger for any range.
   */
  collected(auth: AuthContext, from: string, to: string): Promise<CollectedReport> {
    checkRange(from, to);
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: payments.id,
          date: payments.paymentDate,
          method: payments.method,
          amountKobo: payments.amountKobo,
          reverses: payments.reversesPaymentId,
          bucket: paymentAllocations.bucket,
          allocated: paymentAllocations.amountKobo,
        })
        .from(payments)
        .innerJoin(paymentAllocations, sql`${paymentAllocations.paymentId} = COALESCE(${payments.reversesPaymentId}, ${payments.id})`)
        .where(and(gte(payments.paymentDate, from), lte(payments.paymentDate, to), eq(payments.isOpening, false)))
        .orderBy(asc(payments.paymentDate));

      const days = new Map<string, Tally>();
      const totals = emptyTally();
      const counted = new Set<string>();
      for (const row of rows) {
        const sign = row.reverses ? -1n : 1n;
        const day = days.get(row.date) ?? emptyTally();
        days.set(row.date, day);
        for (const tally of [day, totals]) {
          tally[row.bucket] += sign * row.allocated;
          if (!counted.has(row.id)) {
            tally[row.method] += sign * row.amountKobo;
            if (row.reverses) tally.corrections += 1;
            else tally.receipts += 1;
          }
        }
        counted.add(row.id);
      }

      return {
        from,
        to,
        days: [...days].map(([date, tally]) => ({ date, ...fromTally(tally) })),
        totals: fromTally(totals),
      };
    });
  }

  disbursements(auth: AuthContext, from: string, to: string): Promise<DisbursementsReport> {
    checkRange(from, to);
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx
        .select({ loan: loans, borrowerName: borrowers.fullName })
        .from(loans)
        .innerJoin(borrowers, eq(borrowers.id, loans.borrowerId))
        .where(and(gte(loans.disbursementDate, from), lte(loans.disbursementDate, to), eq(loans.origin, 'new')))
        .orderBy(asc(loans.disbursementDate), asc(loans.reference));

      let principal = 0n;
      let fees = 0n;
      const result = rows.map(({ loan, borrowerName }) => {
        const deducted = loan.terms.fees
          .filter((fee) => fee.timing === 'deducted_upfront')
          .reduce((sum, fee) => sum + feeAmount(fee, loan.principalKobo), 0n);
        principal += loan.principalKobo;
        fees += deducted;
        return {
          loanId: loan.id,
          loanReference: loan.reference,
          date: loan.disbursementDate!,
          borrowerName,
          productName: loan.terms.name,
          method: loan.disbursementMethod!,
          principalKobo: loan.principalKobo.toString(),
          feesDeductedKobo: deducted.toString(),
          paidOutKobo: (loan.principalKobo - deducted).toString(),
        };
      });
      return {
        from,
        to,
        rows: result,
        totalPrincipalKobo: principal.toString(),
        totalFeesDeductedKobo: fees.toString(),
        totalPaidOutKobo: (principal - fees).toString(),
      };
    });
  }

  /** Read straight from the ledger: profit and loss for the range, balance sheet at its end. */
  financials(auth: AuthContext, from: string, to: string): Promise<FinancialsReport> {
    checkRange(from, to);
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const debit = (condition: ReturnType<typeof sql>) =>
        sql<string>`COALESCE(SUM(${journalLines.amountKobo}) FILTER (WHERE ${journalLines.side} = 'debit' AND ${condition}), 0)::text`;
      const credit = (condition: ReturnType<typeof sql>) =>
        sql<string>`COALESCE(SUM(${journalLines.amountKobo}) FILTER (WHERE ${journalLines.side} = 'credit' AND ${condition}), 0)::text`;
      const toEnd = sql`${journalEntries.effectiveDate} <= ${to}`;
      const inRange = sql`${journalEntries.effectiveDate} >= ${from} AND ${journalEntries.effectiveDate} <= ${to}`;

      const rows = await tx
        .select({
          code: ledgerAccounts.code,
          name: ledgerAccounts.name,
          type: ledgerAccounts.type,
          debitToEnd: debit(toEnd),
          creditToEnd: credit(toEnd),
          debitInRange: debit(inRange),
          creditInRange: credit(inRange),
        })
        .from(ledgerAccounts)
        .leftJoin(journalLines, eq(journalLines.accountId, ledgerAccounts.id))
        .leftJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .groupBy(ledgerAccounts.id)
        .orderBy(asc(ledgerAccounts.code));

      const lines = {
        income: [] as FinancialLine[],
        expenses: [] as FinancialLine[],
        assets: [] as FinancialLine[],
        liabilities: [] as FinancialLine[],
        equity: [] as FinancialLine[],
      };
      let income = 0n;
      let expenses = 0n;
      let assets = 0n;
      let claims = 0n;
      let earnings = 0n;
      const add = (list: FinancialLine[], row: { code: string; name: string }, amount: bigint) => {
        if (amount !== 0n) list.push({ code: row.code, name: row.name, amountKobo: amount.toString() });
      };

      for (const row of rows) {
        const debitEnd = BigInt(row.debitToEnd);
        const creditEnd = BigInt(row.creditToEnd);
        const debitRange = BigInt(row.debitInRange);
        const creditRange = BigInt(row.creditInRange);
        if (row.type === 'income') {
          income += creditRange - debitRange;
          earnings += creditEnd - debitEnd;
          add(lines.income, row, creditRange - debitRange);
        } else if (row.type === 'expense') {
          expenses += debitRange - creditRange;
          earnings -= debitEnd - creditEnd;
          add(lines.expenses, row, debitRange - creditRange);
        } else if (row.type === 'asset') {
          assets += debitEnd - creditEnd;
          add(lines.assets, row, debitEnd - creditEnd);
        } else {
          claims += creditEnd - debitEnd;
          add(row.type === 'liability' ? lines.liabilities : lines.equity, row, creditEnd - debitEnd);
        }
      }

      const liabilitiesAndEquity = claims + earnings;
      return {
        from,
        to,
        ...lines,
        totalIncomeKobo: income.toString(),
        totalExpensesKobo: expenses.toString(),
        profitKobo: (income - expenses).toString(),
        earningsToDateKobo: earnings.toString(),
        totalAssetsKobo: assets.toString(),
        totalLiabilitiesAndEquityKobo: liabilitiesAndEquity.toString(),
        balanced: assets === liabilitiesAndEquity,
      };
    });
  }
}
