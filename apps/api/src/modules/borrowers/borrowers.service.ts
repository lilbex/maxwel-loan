import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, ilike, or, sql } from 'drizzle-orm';
import type { Borrower, BorrowerRequest } from '@loan-platform/api-client';
import { PG_UNIQUE_VIOLATION, pgError } from '../../common/errors.js';
import { nextReference } from '../../common/references.js';
import type { AuthContext } from '../../common/request-context.js';
import { DatabaseService } from '../../db/database.service.js';
import { borrowers } from '../../db/schema.js';
import { AuditService } from '../audit/audit.service.js';

type Row = typeof borrowers.$inferSelect;

const toBorrower = (row: Row): Borrower => ({
  id: row.id,
  reference: row.reference,
  fullName: row.fullName,
  phone: row.phone,
  email: row.email ?? undefined,
  address: row.address,
  businessName: row.businessName ?? undefined,
  occupation: row.occupation ?? undefined,
  notes: row.notes ?? undefined,
  createdAt: row.createdAt.toISOString(),
});

/** Clears optional fields that were removed in an edit. */
const toColumns = (input: BorrowerRequest) => ({
  email: null,
  businessName: null,
  occupation: null,
  notes: null,
  ...input,
});

@Injectable()
export class BorrowersService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext, search: string): Promise<Borrower[]> {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(borrowers)
        .where(
          search
            ? or(
                ilike(borrowers.fullName, pattern),
                ilike(borrowers.phone, pattern),
                ilike(borrowers.reference, pattern),
                ilike(borrowers.businessName, pattern),
              )
            : undefined,
        )
        .orderBy(asc(borrowers.fullName))
        .limit(200);
      return rows.map(toBorrower);
    });
  }

  get(auth: AuthContext, id: string): Promise<Borrower> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const [row] = await tx.select().from(borrowers).where(eq(borrowers.id, id));
      if (!row) throw new NotFoundException('Borrower not found');
      return toBorrower(row);
    });
  }

  create(auth: AuthContext, input: BorrowerRequest): Promise<Borrower> {
    return this.phoneChecked(() =>
      this.database.withTenant(auth.tenantId, async (tx) => {
        const reference = await nextReference(tx, auth.tenantId, 'B');
        const [row] = await tx
          .insert(borrowers)
          .values({ ...toColumns(input), tenantId: auth.tenantId, reference })
          .returning();
        await this.audit.record(tx, auth, {
          action: 'borrower.created',
          entityType: 'borrower',
          entityId: row!.id,
          metadata: { reference },
        });
        return toBorrower(row!);
      }),
    );
  }

  update(auth: AuthContext, id: string, input: BorrowerRequest): Promise<Borrower> {
    return this.phoneChecked(() =>
      this.database.withTenant(auth.tenantId, async (tx) => {
        const [before] = await tx.select().from(borrowers).where(eq(borrowers.id, id));
        if (!before) throw new NotFoundException('Borrower not found');
        const [row] = await tx
          .update(borrowers)
          .set({ ...toColumns(input), updatedAt: sql`now()` })
          .where(eq(borrowers.id, id))
          .returning();
        await this.audit.record(tx, auth, {
          action: 'borrower.updated',
          entityType: 'borrower',
          entityId: id,
          metadata: { before: toBorrower(before) },
        });
        return toBorrower(row!);
      }),
    );
  }

  private async phoneChecked<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const { code, constraint } = pgError(error);
      if (code === PG_UNIQUE_VIOLATION && constraint === 'borrowers_phone') {
        throw new ConflictException('Another borrower already uses this phone number');
      }
      throw error;
    }
  }
}
