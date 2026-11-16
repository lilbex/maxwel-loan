import { createHash } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type {
  CreateAccountRequest,
  JournalEntry,
  LedgerAccount,
  OpeningCashRequest,
  PostEntryRequest,
  ReverseEntryRequest,
  TrialBalance,
} from '@loan-platform/api-client';
import { PG_UNIQUE_VIOLATION, pgError } from '../../common/errors.js';
import type { AuthContext } from '../../common/request-context.js';
import { DatabaseService, type Tx } from '../../db/database.service.js';
import { journalEntries, journalLines, ledgerAccounts, tenants } from '../../db/schema.js';
import { AuditService } from '../audit/audit.service.js';

export interface PostingInput extends PostEntryRequest {
  idempotencyKey: string;
  reversesEntryId?: string;
}

@Injectable()
export class LedgerService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * The single way money enters the ledger. It takes the caller's transaction, so later a
   * repayment or disbursement commits together with its journal entry.
   *
   * Replaying an idempotency key with the same content returns the original entry, so a
   * retried webhook or double click cannot post twice.
   */
  async post(tx: Tx, auth: AuthContext, input: PostingInput): Promise<JournalEntry> {
    let debits = 0n;
    let credits = 0n;
    for (const line of input.lines) {
      if (line.side === 'debit') debits += BigInt(line.amountKobo);
      else credits += BigInt(line.amountKobo);
    }
    if (debits !== credits) {
      throw new UnprocessableEntityException(`Entry does not balance: debits ${debits}, credits ${credits}`);
    }

    const codes = [...new Set(input.lines.map((line) => line.accountCode))];
    const accounts = await tx.select().from(ledgerAccounts).where(inArray(ledgerAccounts.code, codes));
    const accountByCode = new Map(accounts.map((account) => [account.code, account]));
    for (const code of codes) {
      const account = accountByCode.get(code);
      if (!account) throw new UnprocessableEntityException(`Unknown ledger account ${code}`);
      if (!account.isActive) throw new UnprocessableEntityException(`Ledger account ${code} is inactive`);
    }

    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          input.effectiveDate,
          input.description,
          input.sourceType ?? null,
          input.sourceId ?? null,
          input.reversesEntryId ?? null,
          input.lines.map((line) => [line.accountCode, line.side, line.amountKobo]),
        ]),
      )
      .digest('hex');

    // A concurrent request with this key waits here until the other transaction finishes.
    const [created] = await tx
      .insert(journalEntries)
      .values({
        tenantId: auth.tenantId,
        effectiveDate: input.effectiveDate,
        description: input.description,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        reversesEntryId: input.reversesEntryId,
        postedByUserId: auth.userId,
      })
      .onConflictDoNothing({ target: [journalEntries.tenantId, journalEntries.idempotencyKey] })
      .returning({ id: journalEntries.id });

    if (!created) {
      const [existing] = await tx
        .select({ id: journalEntries.id, requestHash: journalEntries.requestHash })
        .from(journalEntries)
        .where(eq(journalEntries.idempotencyKey, input.idempotencyKey));
      if (existing?.requestHash !== requestHash) {
        throw new ConflictException('This idempotency key was already used for a different entry');
      }
      return this.loadEntry(tx, existing.id);
    }

    await tx.insert(journalLines).values(
      input.lines.map((line, index) => ({
        tenantId: auth.tenantId,
        entryId: created.id,
        lineNo: index + 1,
        accountId: accountByCode.get(line.accountCode)!.id,
        side: line.side,
        amountKobo: BigInt(line.amountKobo),
      })),
    );
    await this.audit.record(tx, auth, {
      action: input.reversesEntryId ? 'ledger.entry_reversed' : 'ledger.entry_posted',
      entityType: 'journal_entry',
      entityId: created.id,
      metadata: { totalKobo: debits.toString(), reversesEntryId: input.reversesEntryId ?? null },
    });
    return this.loadEntry(tx, created.id);
  }

  postManual(auth: AuthContext, idempotencyKey: string, input: PostEntryRequest): Promise<JournalEntry> {
    return this.translated(() =>
      this.database.withTenant(auth.tenantId, (tx) => this.post(tx, auth, { ...input, idempotencyKey })),
    );
  }

  /** Cash and bank at the time a lender starts on the system, set against Opening balances. */
  postOpeningCash(auth: AuthContext, key: string, input: OpeningCashRequest): Promise<JournalEntry> {
    return this.translated(() =>
      this.database.withTenant(auth.tenantId, async (tx) => {
        const [tenant] = await tx
          .select({ today: sql<string>`(now() AT TIME ZONE ${tenants.timezone})::date::text` })
          .from(tenants);
        return this.post(tx, auth, {
          idempotencyKey: key,
          effectiveDate: tenant!.today,
          description: `Opening ${input.account === 'cash' ? 'cash on hand' : 'bank balance'}`,
          sourceType: 'opening',
          lines: [
            { accountCode: input.account === 'cash' ? '1000' : '1010', side: 'debit', amountKobo: input.amountKobo },
            { accountCode: '3200', side: 'credit', amountKobo: input.amountKobo },
          ],
        });
      }),
    );
  }

  /** Posts the mirror image of an entry. The original stays in place, unchanged. */
  reverse(
    auth: AuthContext,
    entryId: string,
    idempotencyKey: string,
    input: ReverseEntryRequest,
  ): Promise<JournalEntry> {
    return this.translated(() =>
      this.database.withTenant(auth.tenantId, (tx) => this.reverseWithin(tx, auth, entryId, idempotencyKey, input)),
    );
  }

  /** The same reversal inside the caller's transaction, so it commits with the caller's own changes. */
  async reverseWithin(
    tx: Tx,
    auth: AuthContext,
    entryId: string,
    idempotencyKey: string,
    input: ReverseEntryRequest,
  ): Promise<JournalEntry> {
    const original = await this.loadEntry(tx, entryId);
    if (original.reversesEntryId) {
      throw new UnprocessableEntityException('A reversal cannot itself be reversed. Post a new entry instead.');
    }
    return this.post(tx, auth, {
      idempotencyKey,
      reversesEntryId: original.id,
      effectiveDate: input.effectiveDate,
      description: `Reversal: ${input.reason}`,
      sourceType: 'reversal',
      sourceId: original.id,
      lines: original.lines.map((line) => ({
        accountCode: line.accountCode,
        side: line.side === 'debit' ? 'credit' : 'debit',
        amountKobo: line.amountKobo,
      })),
    });
  }

  getEntry(auth: AuthContext, entryId: string): Promise<JournalEntry> {
    return this.database.withTenant(auth.tenantId, (tx) => this.loadEntry(tx, entryId));
  }

  private async loadEntry(tx: Tx, entryId: string): Promise<JournalEntry> {
    const [entry] = await tx.select().from(journalEntries).where(eq(journalEntries.id, entryId));
    if (!entry) throw new NotFoundException('Journal entry not found');
    const lines = await tx
      .select({
        lineNo: journalLines.lineNo,
        accountCode: ledgerAccounts.code,
        accountName: ledgerAccounts.name,
        side: journalLines.side,
        amountKobo: journalLines.amountKobo,
      })
      .from(journalLines)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
      .where(eq(journalLines.entryId, entryId))
      .orderBy(asc(journalLines.lineNo));
    return {
      id: entry.id,
      effectiveDate: entry.effectiveDate,
      description: entry.description,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      reversesEntryId: entry.reversesEntryId,
      postedByUserId: entry.postedByUserId,
      postedAt: entry.postedAt.toISOString(),
      lines: lines.map((line) => ({ ...line, amountKobo: line.amountKobo.toString() })),
    };
  }

  listAccounts(auth: AuthContext): Promise<LedgerAccount[]> {
    return this.database.withTenant(auth.tenantId, (tx) =>
      tx
        .select({
          id: ledgerAccounts.id,
          code: ledgerAccounts.code,
          name: ledgerAccounts.name,
          type: ledgerAccounts.type,
          isActive: ledgerAccounts.isActive,
        })
        .from(ledgerAccounts)
        .orderBy(asc(ledgerAccounts.code)),
    );
  }

  async createAccount(auth: AuthContext, input: CreateAccountRequest): Promise<LedgerAccount> {
    try {
      return await this.database.withTenant(auth.tenantId, async (tx) => {
        const [account] = await tx
          .insert(ledgerAccounts)
          .values({ ...input, tenantId: auth.tenantId })
          .returning({
            id: ledgerAccounts.id,
            code: ledgerAccounts.code,
            name: ledgerAccounts.name,
            type: ledgerAccounts.type,
            isActive: ledgerAccounts.isActive,
          });
        await this.audit.record(tx, auth, {
          action: 'ledger.account_created',
          entityType: 'ledger_account',
          entityId: account!.id,
          metadata: { code: input.code },
        });
        return account!;
      });
    } catch (error) {
      if (pgError(error).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException(`Ledger account ${input.code} already exists`);
      }
      throw error;
    }
  }

  /** Without a date, "today" is the lender's local date rather than the server's. */
  trialBalance(auth: AuthContext, requestedAsOf?: string): Promise<TrialBalance> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const [tenant] = await tx
        .select({ today: sql<string>`(now() AT TIME ZONE ${tenants.timezone})::date::text` })
        .from(tenants);
      const asOf = requestedAsOf ?? tenant!.today;

      const rows = await tx
        .select({
          code: ledgerAccounts.code,
          name: ledgerAccounts.name,
          type: ledgerAccounts.type,
          // SUM(bigint) is numeric in PostgreSQL, so totals cannot overflow. Text keeps every digit.
          debit: sql<string>`COALESCE(SUM(${journalLines.amountKobo}) FILTER (WHERE ${journalLines.side} = 'debit'), 0)::text`,
          credit: sql<string>`COALESCE(SUM(${journalLines.amountKobo}) FILTER (WHERE ${journalLines.side} = 'credit'), 0)::text`,
        })
        .from(ledgerAccounts)
        .leftJoin(
          sql`(${journalLines} INNER JOIN ${journalEntries} ON ${journalEntries.id} = ${journalLines.entryId}
               AND ${journalEntries.effectiveDate} <= ${asOf})`,
          eq(journalLines.accountId, ledgerAccounts.id),
        )
        .groupBy(ledgerAccounts.id)
        .orderBy(asc(ledgerAccounts.code));

      let totalDebit = 0n;
      let totalCredit = 0n;
      const result = rows.map((row) => {
        const debit = BigInt(row.debit);
        const credit = BigInt(row.credit);
        totalDebit += debit;
        totalCredit += credit;
        const debitNormal = row.type === 'asset' || row.type === 'expense';
        return {
          code: row.code,
          name: row.name,
          type: row.type,
          debitKobo: debit.toString(),
          creditKobo: credit.toString(),
          balanceKobo: (debitNormal ? debit - credit : credit - debit).toString(),
        };
      });

      return {
        asOf,
        rows: result,
        totalDebitKobo: totalDebit.toString(),
        totalCreditKobo: totalCredit.toString(),
        balanced: totalDebit === totalCredit,
      };
    });
  }

  /** Turns database-level rejections, reached only by races, into clean API responses. */
  private async translated<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const { code, constraint } = pgError(error);
      if (code === 'LP002' || code === 'LP003') throw new UnprocessableEntityException('The ledger rejected this entry');
      if (code === PG_UNIQUE_VIOLATION && constraint === 'journal_entries_one_reversal') {
        throw new ConflictException('This entry has already been reversed');
      }
      throw error;
    }
  }
}
