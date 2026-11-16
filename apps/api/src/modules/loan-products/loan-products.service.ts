import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import type {
  LoanProduct,
  LoanProductRequest,
  LoanSchedule,
  SchedulePreviewRequest,
} from '@loan-platform/api-client';
import { PG_UNIQUE_VIOLATION, pgError } from '../../common/errors.js';
import type { AuthContext } from '../../common/request-context.js';
import { DatabaseService, type Tx } from '../../db/database.service.js';
import { loanProducts } from '../../db/schema.js';
import { AuditService } from '../audit/audit.service.js';
import { buildSchedule, ScheduleError } from './schedule.js';

type ProductRow = typeof loanProducts.$inferSelect;

function toProduct(row: ProductRow): LoanProduct {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    interestMethod: row.interestMethod,
    ratePercent: row.ratePercent.replace(/\.?0+$/, ''),
    ratePeriod: row.ratePeriod,
    repaymentFrequency: row.repaymentFrequency,
    periodBasis: row.periodBasis,
    minPrincipalKobo: row.minPrincipalKobo.toString(),
    maxPrincipalKobo: row.maxPrincipalKobo.toString(),
    minTerm: row.minTerm,
    maxTerm: row.maxTerm,
    roundingUnitKobo: row.roundingUnitKobo as LoanProduct['roundingUnitKobo'],
    fees: row.fees,
    penalty: row.penalty,
    allocationOrder: row.allocationOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const toColumns = (input: LoanProductRequest) => ({
  ...input,
  minPrincipalKobo: BigInt(input.minPrincipalKobo),
  maxPrincipalKobo: BigInt(input.maxPrincipalKobo),
});

@Injectable()
export class LoanProductsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext): Promise<LoanProduct[]> {
    return this.database.withTenant(auth.tenantId, async (tx) =>
      (await tx.select().from(loanProducts).orderBy(asc(loanProducts.name))).map(toProduct),
    );
  }

  get(auth: AuthContext, id: string): Promise<LoanProduct> {
    return this.database.withTenant(auth.tenantId, async (tx) => toProduct(await this.find(tx, id)));
  }

  create(auth: AuthContext, input: LoanProductRequest): Promise<LoanProduct> {
    return this.nameChecked(() =>
      this.database.withTenant(auth.tenantId, async (tx) => {
        const [row] = await tx
          .insert(loanProducts)
          .values({ ...toColumns(input), tenantId: auth.tenantId })
          .returning();
        await this.audit.record(tx, auth, {
          action: 'product.created',
          entityType: 'loan_product',
          entityId: row!.id,
          metadata: { name: input.name },
        });
        return toProduct(row!);
      }),
    );
  }

  update(auth: AuthContext, id: string, input: LoanProductRequest): Promise<LoanProduct> {
    return this.nameChecked(() =>
      this.database.withTenant(auth.tenantId, async (tx) => {
        const before = toProduct(await this.find(tx, id));
        const [row] = await tx
          .update(loanProducts)
          .set({ ...toColumns(input), updatedAt: sql`now()` })
          .where(eq(loanProducts.id, id))
          .returning();
        await this.audit.record(tx, auth, {
          action: 'product.updated',
          entityType: 'loan_product',
          entityId: id,
          metadata: { before },
        });
        return toProduct(row!);
      }),
    );
  }

  setStatus(auth: AuthContext, id: string, status: 'active' | 'archived'): Promise<LoanProduct> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      await this.find(tx, id);
      const [row] = await tx
        .update(loanProducts)
        .set({ status, updatedAt: sql`now()` })
        .where(eq(loanProducts.id, id))
        .returning();
      await this.audit.record(tx, auth, {
        action: status === 'archived' ? 'product.archived' : 'product.reactivated',
        entityType: 'loan_product',
        entityId: id,
      });
      return toProduct(row!);
    });
  }

  async preview(auth: AuthContext, id: string, input: SchedulePreviewRequest): Promise<LoanSchedule> {
    const product = await this.get(auth, id);
    const principal = BigInt(input.principalKobo);
    if (principal < BigInt(product.minPrincipalKobo) || principal > BigInt(product.maxPrincipalKobo)) {
      throw new UnprocessableEntityException('Loan amount is outside this product’s range');
    }
    if (input.termCount < product.minTerm || input.termCount > product.maxTerm) {
      throw new UnprocessableEntityException('Term is outside this product’s range');
    }
    try {
      return buildSchedule(product, { ...input, principalKobo: principal });
    } catch (error) {
      if (error instanceof ScheduleError) throw new UnprocessableEntityException(error.message);
      throw error;
    }
  }

  private async find(tx: Tx, id: string): Promise<ProductRow> {
    const [row] = await tx.select().from(loanProducts).where(eq(loanProducts.id, id));
    if (!row) throw new NotFoundException('Loan product not found');
    return row;
  }

  private async nameChecked<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (pgError(error).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException('A loan product with this name already exists');
      }
      throw error;
    }
  }
}
