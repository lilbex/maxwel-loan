import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type {
  ApplicationStatus,
  ApplicationSummary,
  DecisionRequest,
  LoanApplication,
  LoanApplicationRequest,
  LoanTermsSnapshot,
  ExistingLoanPreview,
  ExistingLoanRequest,
} from '@loan-platform/api-client';
import { nextReference } from '../../common/references.js';
import type { AuthContext } from '../../common/request-context.js';
import { DatabaseService, type Tx } from '../../db/database.service.js';
import {
  approvals,
  borrowers,
  collateral,
  guarantors,
  loanApplications,
  loanProducts,
  loans,
  payments,
  paymentAllocations,
  scheduleItems,
  users,
} from '../../db/schema.js';
import { AuditService } from '../audit/audit.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { buildSchedule, ScheduleError } from '../loan-products/schedule.js';
import { allocatePayment, type OpenInstallment } from './allocation.js';
import { tenantToday } from './position.js';

const summaryColumns = {
  id: loanApplications.id,
  reference: loanApplications.reference,
  kind: loanApplications.kind,
  status: loanApplications.status,
  borrowerId: loanApplications.borrowerId,
  borrowerName: borrowers.fullName,
  productId: loanApplications.productId,
  productName: loanProducts.name,
  principalKobo: loanApplications.principalKobo,
  termCount: loanApplications.termCount,
  createdAt: loanApplications.createdAt,
};

type ProductRow = typeof loanProducts.$inferSelect;

@Injectable()
export class ApplicationsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  list(auth: AuthContext, filter: { status?: ApplicationStatus; borrowerId?: string }): Promise<ApplicationSummary[]> {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(loanApplications.status, filter.status));
    if (filter.borrowerId) conditions.push(eq(loanApplications.borrowerId, filter.borrowerId));
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx
        .select(summaryColumns)
        .from(loanApplications)
        .innerJoin(borrowers, eq(borrowers.id, loanApplications.borrowerId))
        .innerJoin(loanProducts, eq(loanProducts.id, loanApplications.productId))
        .where(and(...conditions))
        .orderBy(desc(loanApplications.createdAt))
        .limit(200);
      return rows.map((row) => ({
        ...row,
        principalKobo: row.principalKobo.toString(),
        createdAt: row.createdAt.toISOString(),
      }));
    });
  }

  get(auth: AuthContext, id: string): Promise<LoanApplication> {
    return this.database.withTenant(auth.tenantId, (tx) => this.load(tx, id));
  }

  private async load(tx: Tx, id: string): Promise<LoanApplication> {
    const preparer = alias(users, 'preparer');
    const [row] = await tx
      .select({
        ...summaryColumns,
        purpose: loanApplications.purpose,
        existingDisbursementDate: loanApplications.existingDisbursementDate,
        existingFirstDueDate: loanApplications.existingFirstDueDate,
        existingPaidKobo: loanApplications.existingPaidKobo,
        paperReference: loanApplications.paperReference,
        preparedByUserId: loanApplications.preparedByUserId,
        preparedByName: preparer.fullName,
        submittedByUserId: loanApplications.submittedByUserId,
        loanId: loans.id,
      })
      .from(loanApplications)
      .innerJoin(borrowers, eq(borrowers.id, loanApplications.borrowerId))
      .innerJoin(loanProducts, eq(loanProducts.id, loanApplications.productId))
      .innerJoin(preparer, eq(preparer.id, loanApplications.preparedByUserId))
      .leftJoin(loans, eq(loans.applicationId, loanApplications.id))
      .where(eq(loanApplications.id, id));
    if (!row) throw new NotFoundException('Loan application not found');

    const guarantorRows = await tx
      .select({
        fullName: guarantors.fullName,
        phone: guarantors.phone,
        address: guarantors.address,
        relationship: guarantors.relationship,
      })
      .from(guarantors)
      .where(eq(guarantors.applicationId, id))
      .orderBy(asc(guarantors.position));
    const collateralRows = await tx
      .select({ description: collateral.description, estimatedValueKobo: collateral.estimatedValueKobo })
      .from(collateral)
      .where(eq(collateral.applicationId, id))
      .orderBy(asc(collateral.position));
    const decisionRows = await tx
      .select({
        decision: approvals.decision,
        note: approvals.note,
        decidedByName: users.fullName,
        createdAt: approvals.createdAt,
      })
      .from(approvals)
      .innerJoin(users, eq(users.id, approvals.decidedByUserId))
      .where(eq(approvals.applicationId, id))
      .orderBy(asc(approvals.createdAt));

    const { existingDisbursementDate, existingFirstDueDate, existingPaidKobo, paperReference, ...fields } = row;
    let existing: LoanApplication['existing'] = null;
    if (existingDisbursementDate && existingPaidKobo !== null) {
      const [product] = await tx.select().from(loanProducts).where(eq(loanProducts.id, row.productId));
      existing = {
        disbursementDate: existingDisbursementDate,
        firstDueDate: existingFirstDueDate,
        paidKobo: existingPaidKobo.toString(),
        paperReference,
        preview: this.computeExisting(product!, await tenantToday(tx), {
          principalKobo: row.principalKobo.toString(),
          termCount: row.termCount,
          disbursementDate: existingDisbursementDate,
          firstDueDate: existingFirstDueDate ?? undefined,
          paidKobo: existingPaidKobo.toString(),
        }),
      };
    }

    return {
      ...fields,
      existing,
      principalKobo: row.principalKobo.toString(),
      createdAt: row.createdAt.toISOString(),
      guarantors: guarantorRows,
      collateral: collateralRows.map((item) => ({
        description: item.description,
        estimatedValueKobo: item.estimatedValueKobo.toString(),
      })),
      decisions: decisionRows.map((decision) => ({ ...decision, createdAt: decision.createdAt.toISOString() })),
    };
  }

  create(auth: AuthContext, input: LoanApplicationRequest): Promise<LoanApplication> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      await this.requireBorrower(tx, input.borrowerId);
      this.checkAgainstProduct(await this.requireProduct(tx, input.productId), input);
      const reference = await nextReference(tx, auth.tenantId, 'A');
      const [row] = await tx
        .insert(loanApplications)
        .values({
          tenantId: auth.tenantId,
          reference,
          borrowerId: input.borrowerId,
          productId: input.productId,
          principalKobo: BigInt(input.principalKobo),
          termCount: input.termCount,
          purpose: input.purpose,
          preparedByUserId: auth.userId,
        })
        .returning({ id: loanApplications.id });
      await this.saveParties(tx, auth.tenantId, row!.id, input);
      await this.audit.record(tx, auth, {
        action: 'application.created',
        entityType: 'loan_application',
        entityId: row!.id,
        metadata: { reference },
      });
      return this.load(tx, row!.id);
    });
  }

  /** Only a draft can change, so what an approver reads is exactly what gets approved. */
  update(auth: AuthContext, id: string, input: LoanApplicationRequest): Promise<LoanApplication> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const application = await this.lock(tx, id);
      if (application.status !== 'draft') throw new ConflictException('Only a draft application can be changed');
      if (application.kind !== 'new') throw new ConflictException('This records an existing loan');
      await this.requireBorrower(tx, input.borrowerId);
      this.checkAgainstProduct(await this.requireProduct(tx, input.productId), input);
      await tx
        .update(loanApplications)
        .set({
          borrowerId: input.borrowerId,
          productId: input.productId,
          principalKobo: BigInt(input.principalKobo),
          termCount: input.termCount,
          purpose: input.purpose,
          updatedAt: sql`now()`,
        })
        .where(eq(loanApplications.id, id));
      await tx.delete(guarantors).where(eq(guarantors.applicationId, id));
      await tx.delete(collateral).where(eq(collateral.applicationId, id));
      await this.saveParties(tx, auth.tenantId, id, input);
      await this.audit.record(tx, auth, { action: 'application.updated', entityType: 'loan_application', entityId: id });
      return this.load(tx, id);
    });
  }

  private snapshot(product: ProductRow): LoanTermsSnapshot {
    return {
      name: product.name,
      interestMethod: product.interestMethod,
      ratePercent: product.ratePercent.replace(/\.?0+$/, ''),
      ratePeriod: product.ratePeriod,
      repaymentFrequency: product.repaymentFrequency,
      periodBasis: product.periodBasis,
      roundingUnitKobo: product.roundingUnitKobo as LoanTermsSnapshot['roundingUnitKobo'],
      fees: product.fees,
      penalty: product.penalty,
      allocationOrder: product.allocationOrder,
    };
  }

  /** Works out what a loan on paper should look like now, using the normal schedule and allocation rules. */
  private computeExisting(
    product: ProductRow,
    today: string,
    input: Pick<ExistingLoanRequest, 'principalKobo' | 'termCount' | 'disbursementDate' | 'firstDueDate' | 'paidKobo'>,
  ): ExistingLoanPreview {
    const principal = BigInt(input.principalKobo);
    const paid = BigInt(input.paidKobo);
    const terms = this.snapshot(product);
    let schedule;
    try {
      schedule = buildSchedule(terms, {
        principalKobo: principal,
        termCount: input.termCount,
        disbursementDate: input.disbursementDate,
        firstDueDate: input.firstDueDate,
      });
    } catch (error) {
      if (error instanceof ScheduleError) throw new UnprocessableEntityException(error.message);
      throw error;
    }

    const open = this.openFrom(schedule.installments.map((item) => ({ ...item, id: String(item.number) })));
    const allocations = allocatePayment(paid, open, terms.allocationOrder);
    const paidOf = (id: string, bucket: string) =>
      allocations
        .filter((row) => row.scheduleItemId === id && row.bucket === bucket)
        .reduce((sum, row) => sum + row.amountKobo, 0n);

    let principalOwed = 0n;
    let interestOwed = 0n;
    let feesOwed = 0n;
    let overdue = 0n;
    let cleared = 0;
    for (const item of schedule.installments) {
      const id = String(item.number);
      const principalLeft = BigInt(item.principalKobo) - paidOf(id, 'principal');
      const interestLeft = BigInt(item.interestKobo) - paidOf(id, 'interest');
      const feeLeft = BigInt(item.feeKobo) - paidOf(id, 'fee');
      const left = principalLeft + interestLeft + feeLeft;
      principalOwed += principalLeft;
      interestOwed += interestLeft;
      feesOwed += feeLeft;
      if (left === 0n) cleared += 1;
      else if (item.dueDate < today) overdue += left;
    }

    const total = BigInt(schedule.totalRepayableKobo);
    return {
      totalRepayableKobo: total.toString(),
      paidKobo: paid.toString(),
      owedKobo: (total - paid).toString(),
      principalOwedKobo: principalOwed.toString(),
      interestOwedKobo: interestOwed.toString(),
      feesOwedKobo: feesOwed.toString(),
      overdueKobo: overdue.toString(),
      installmentsCleared: cleared,
      installments: schedule.installments,
    };
  }

  private openFrom(
    items: { id: string; principalKobo: string | bigint; interestKobo: string | bigint; feeKobo: string | bigint }[],
  ): OpenInstallment[] {
    return items.map((item) => ({
      id: item.id,
      remaining: {
        penalty: 0n,
        fee: BigInt(item.feeKobo),
        interest: BigInt(item.interestKobo),
        principal: BigInt(item.principalKobo),
      },
    }));
  }

  private checkExisting(preview: ExistingLoanPreview, input: { disbursementDate: string }, today: string): void {
    if (input.disbursementDate > today) {
      throw new UnprocessableEntityException('The date the loan was paid out cannot be in the future');
    }
    if (BigInt(preview.owedKobo) <= 0n) {
      throw new UnprocessableEntityException('This loan is already fully repaid, so it does not need moving across');
    }
    if (BigInt(preview.principalOwedKobo) === 0n) {
      throw new UnprocessableEntityException('No principal is left on this loan. Check the amount paid so far.');
    }
  }

  previewExisting(auth: AuthContext, input: ExistingLoanRequest): Promise<ExistingLoanPreview> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const product = await this.requireProduct(tx, input.productId);
      const today = await tenantToday(tx);
      const preview = this.computeExisting(product, today, input);
      this.checkExisting(preview, input, today);
      return preview;
    });
  }

  private existingColumns(input: ExistingLoanRequest) {
    return {
      borrowerId: input.borrowerId,
      productId: input.productId,
      principalKobo: BigInt(input.principalKobo),
      termCount: input.termCount,
      existingDisbursementDate: input.disbursementDate,
      existingFirstDueDate: input.firstDueDate ?? null,
      existingPaidKobo: BigInt(input.paidKobo),
      paperReference: input.paperReference ?? null,
    };
  }

  createExisting(auth: AuthContext, input: ExistingLoanRequest): Promise<LoanApplication> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      await this.requireBorrower(tx, input.borrowerId);
      const today = await tenantToday(tx);
      this.checkExisting(this.computeExisting(await this.requireProduct(tx, input.productId), today, input), input, today);
      const reference = await nextReference(tx, auth.tenantId, 'A');
      const [row] = await tx
        .insert(loanApplications)
        .values({
          ...this.existingColumns(input),
          tenantId: auth.tenantId,
          reference,
          kind: 'existing',
          purpose: 'Existing loan moved from paper records',
          preparedByUserId: auth.userId,
        })
        .returning({ id: loanApplications.id });
      await this.audit.record(tx, auth, {
        action: 'application.created',
        entityType: 'loan_application',
        entityId: row!.id,
        metadata: { reference, kind: 'existing' },
      });
      return this.load(tx, row!.id);
    });
  }

  updateExisting(auth: AuthContext, id: string, input: ExistingLoanRequest): Promise<LoanApplication> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const application = await this.lock(tx, id);
      if (application.kind !== 'existing') throw new ConflictException('This is a new loan application');
      if (application.status !== 'draft') throw new ConflictException('Only a draft can be changed');
      await this.requireBorrower(tx, input.borrowerId);
      const today = await tenantToday(tx);
      this.checkExisting(this.computeExisting(await this.requireProduct(tx, input.productId), today, input), input, today);
      await tx
        .update(loanApplications)
        .set({ ...this.existingColumns(input), updatedAt: sql`now()` })
        .where(eq(loanApplications.id, id));
      await this.audit.record(tx, auth, { action: 'application.updated', entityType: 'loan_application', entityId: id });
      return this.load(tx, id);
    });
  }

  submit(auth: AuthContext, id: string): Promise<LoanApplication> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const application = await this.lock(tx, id);
      if (application.status !== 'draft') throw new ConflictException('Only a draft application can be submitted');
      const product = await this.requireProduct(tx, application.productId);
      if (application.kind === 'new') {
        this.checkAgainstProduct(product, {
          principalKobo: application.principalKobo.toString(),
          termCount: application.termCount,
        });
      }
      await tx
        .update(loanApplications)
        .set({ status: 'submitted', submittedByUserId: auth.userId, updatedAt: sql`now()` })
        .where(eq(loanApplications.id, id));
      await this.audit.record(tx, auth, { action: 'application.submitted', entityType: 'loan_application', entityId: id });
      return this.load(tx, id);
    });
  }

  decide(auth: AuthContext, id: string, input: DecisionRequest): Promise<LoanApplication> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const application = await this.lock(tx, id);
      if (application.status !== 'submitted') {
        throw new ConflictException('This application is not waiting for a decision');
      }
      if (auth.userId === application.preparedByUserId || auth.userId === application.submittedByUserId) {
        throw new ForbiddenException('The person who prepared an application cannot decide on it');
      }

      await tx.insert(approvals).values({
        tenantId: auth.tenantId,
        applicationId: id,
        decision: input.decision,
        note: input.note,
        decidedByUserId: auth.userId,
      });

      const status = { approved: 'approved', rejected: 'rejected', returned: 'draft' } as const;
      await tx
        .update(loanApplications)
        .set({
          status: status[input.decision],
          submittedByUserId: input.decision === 'returned' ? null : application.submittedByUserId,
          updatedAt: sql`now()`,
        })
        .where(eq(loanApplications.id, id));

      if (input.decision === 'approved') await this.createLoan(tx, auth, application);
      await this.audit.record(tx, auth, {
        action: `application.${input.decision}`,
        entityType: 'loan_application',
        entityId: id,
        metadata: { note: input.note ?? null },
      });
      return this.load(tx, id);
    });
  }

  private async createLoan(tx: Tx, auth: AuthContext, application: typeof loanApplications.$inferSelect) {
    const product = await this.requireProduct(tx, application.productId);
    const terms = this.snapshot(product);
    const today = await tenantToday(tx);
    let existing: ExistingLoanPreview | null = null;

    if (application.kind === 'existing') {
      const input = {
        principalKobo: application.principalKobo.toString(),
        termCount: application.termCount,
        disbursementDate: application.existingDisbursementDate!,
        firstDueDate: application.existingFirstDueDate ?? undefined,
        paidKobo: application.existingPaidKobo!.toString(),
      };
      existing = this.computeExisting(product, today, input);
      this.checkExisting(existing, input, today);
    } else {
      this.checkAgainstProduct(product, {
        principalKobo: application.principalKobo.toString(),
        termCount: application.termCount,
      });
      try {
        // Amounts do not depend on the date, so any date proves the loan can be scheduled.
        buildSchedule(terms, {
          principalKobo: application.principalKobo,
          termCount: application.termCount,
          disbursementDate: '2000-01-01',
        });
      } catch (error) {
        if (error instanceof ScheduleError) throw new UnprocessableEntityException(error.message);
        throw error;
      }
    }

    const reference = await nextReference(tx, auth.tenantId, 'L');
    const [loan] = await tx
      .insert(loans)
      .values({
        tenantId: auth.tenantId,
        reference,
        applicationId: application.id,
        borrowerId: application.borrowerId,
        principalKobo: application.principalKobo,
        termCount: application.termCount,
        terms,
        origin: application.kind,
        preparedByUserId: application.submittedByUserId ?? application.preparedByUserId,
        approvedByUserId: auth.userId,
      })
      .returning({ id: loans.id });
    await this.audit.record(tx, auth, {
      action: 'loan.approved',
      entityType: 'loan',
      entityId: loan!.id,
      metadata: { reference },
    });

    if (existing) await this.moveInExisting(tx, auth, application, loan!.id, reference, terms, existing, today);
  }

  /**
   * Brings a confirmed paper loan onto the books. The principal still owed joins the ledger
   * against Opening balances, so no cash moves and old payments do not count as income now.
   * The paper total becomes one opening payment, so normal rules carry the loan from here.
   */
  private async moveInExisting(
    tx: Tx,
    auth: AuthContext,
    application: typeof loanApplications.$inferSelect,
    loanId: string,
    loanReference: string,
    terms: LoanTermsSnapshot,
    preview: ExistingLoanPreview,
    today: string,
  ): Promise<void> {
    const entry = await this.ledger.post(tx, auth, {
      idempotencyKey: `opening-loan:${loanId}`,
      effectiveDate: today,
      description: `Opening balance of loan ${loanReference}`,
      sourceType: 'loan',
      sourceId: loanId,
      lines: [
        { accountCode: '1100', side: 'debit', amountKobo: preview.principalOwedKobo },
        { accountCode: '3200', side: 'credit', amountKobo: preview.principalOwedKobo },
      ],
    });

    const items = await tx
      .insert(scheduleItems)
      .values(
        preview.installments.map((item) => ({
          tenantId: auth.tenantId,
          loanId,
          number: item.number,
          dueDate: item.dueDate,
          principalKobo: BigInt(item.principalKobo),
          interestKobo: BigInt(item.interestKobo),
          feeKobo: BigInt(item.feeKobo),
          totalKobo: BigInt(item.totalKobo),
          balanceAfterKobo: BigInt(item.balanceAfterKobo),
        })),
      )
      .returning();
    items.sort((a, b) => a.number - b.number);

    const paid = application.existingPaidKobo!;
    if (paid > 0n) {
      const reference = await nextReference(tx, auth.tenantId, 'OB');
      const [payment] = await tx
        .insert(payments)
        .values({
          tenantId: auth.tenantId,
          reference,
          loanId,
          amountKobo: paid,
          paymentDate: today,
          method: 'cash',
          note: 'Total repaid before moving to this system',
          idempotencyKey: `opening-loan:${loanId}`,
          requestHash: 'opening',
          isOpening: true,
          balanceAfterKobo: BigInt(preview.owedKobo),
          journalEntryId: entry.id,
          recordedByUserId: auth.userId,
        })
        .returning({ id: payments.id });
      await tx.insert(paymentAllocations).values(
        allocatePayment(paid, this.openFrom(items), terms.allocationOrder).map((allocation) => ({
          tenantId: auth.tenantId,
          paymentId: payment!.id,
          scheduleItemId: allocation.scheduleItemId,
          bucket: allocation.bucket,
          amountKobo: allocation.amountKobo,
        })),
      );
    }

    await tx
      .update(loans)
      .set({
        status: 'active',
        disbursementDate: application.existingDisbursementDate,
        disbursedByUserId: auth.userId,
        disbursementEntryId: entry.id,
        penaltiesAfter: today,
        updatedAt: sql`now()`,
      })
      .where(eq(loans.id, loanId));
    await this.audit.record(tx, auth, {
      action: 'loan.moved_in',
      entityType: 'loan',
      entityId: loanId,
      metadata: { reference: loanReference, paidKobo: paid.toString(), owedKobo: preview.owedKobo },
    });
  }

  private async lock(tx: Tx, id: string) {
    const [application] = await tx.select().from(loanApplications).where(eq(loanApplications.id, id)).for('update');
    if (!application) throw new NotFoundException('Loan application not found');
    return application;
  }

  private async requireBorrower(tx: Tx, id: string): Promise<void> {
    const [row] = await tx.select({ id: borrowers.id }).from(borrowers).where(eq(borrowers.id, id));
    if (!row) throw new UnprocessableEntityException('Borrower not found');
  }

  private async requireProduct(tx: Tx, id: string): Promise<ProductRow> {
    const [row] = await tx.select().from(loanProducts).where(eq(loanProducts.id, id));
    if (!row) throw new UnprocessableEntityException('Loan product not found');
    if (row.status !== 'active') throw new UnprocessableEntityException(`${row.name} is archived`);
    return row;
  }

  private checkAgainstProduct(product: ProductRow, input: { principalKobo: string; termCount: number }): void {
    const principal = BigInt(input.principalKobo);
    if (principal < product.minPrincipalKobo || principal > product.maxPrincipalKobo) {
      throw new UnprocessableEntityException('Loan amount is outside this product’s range');
    }
    if (input.termCount < product.minTerm || input.termCount > product.maxTerm) {
      throw new UnprocessableEntityException('Term is outside this product’s range');
    }
  }

  private async saveParties(tx: Tx, tenantId: string, applicationId: string, input: LoanApplicationRequest) {
    if (input.guarantors.length) {
      await tx
        .insert(guarantors)
        .values(input.guarantors.map((item, position) => ({ ...item, tenantId, applicationId, position })));
    }
    if (input.collateral.length) {
      await tx.insert(collateral).values(
        input.collateral.map((item, position) => ({
          description: item.description,
          estimatedValueKobo: BigInt(item.estimatedValueKobo),
          tenantId,
          applicationId,
          position,
        })),
      );
    }
  }
}
