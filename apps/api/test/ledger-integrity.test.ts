import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appClient, asTenant, createTenant } from './helpers.js';

/** These tests go straight at the database, as a bug or a careless script would. */
describe('ledger rules enforced by the database', () => {
  let client: pg.Client;
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let userId: string;
  let cash: string;
  let capital: string;

  const insertEntry = async () =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO journal_entries (tenant_id, effective_date, description, idempotency_key, request_hash, posted_by_user_id)
         VALUES ($1, '2026-11-05', 'test', $2, 'h', $3) RETURNING id`,
        [tenant.id, randomUUID(), userId],
      )
    ).rows[0]!.id;

  const insertLine = (entryId: string, no: number, account: string, side: string, amount: string | number) =>
    client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, line_no, account_id, side, amount_kobo) VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenant.id, entryId, no, account, side, amount],
    );

  const postBalanced = () =>
    asTenant(client, tenant.id, async () => {
      const id = await insertEntry();
      await insertLine(id, 1, cash, 'debit', 100);
      await insertLine(id, 2, capital, 'credit', 100);
      return id;
    });

  beforeAll(async () => {
    client = await appClient();
    tenant = await createTenant();
    await asTenant(client, tenant.id, async () => {
      userId = (await client.query('SELECT id FROM users')).rows[0].id;
      const { rows } = await client.query(`SELECT id, code FROM ledger_accounts WHERE code IN ('1000', '3000')`);
      cash = rows.find((row) => row.code === '1000').id;
      capital = rows.find((row) => row.code === '3000').id;
    });
  });
  afterAll(() => client.end());

  it('commits a balanced entry', async () => {
    await expect(postBalanced()).resolves.toBeTruthy();
  });

  it('rejects an unbalanced entry at commit', async () => {
    await expect(
      asTenant(client, tenant.id, async () => {
        const id = await insertEntry();
        await insertLine(id, 1, cash, 'debit', 100);
        await insertLine(id, 2, capital, 'credit', 99);
      }),
    ).rejects.toMatchObject({ code: 'LP002' });
  });

  it('rejects an entry with no lines', async () => {
    await expect(asTenant(client, tenant.id, insertEntry)).rejects.toMatchObject({ code: 'LP002' });
  });

  it('rejects zero and negative amounts', async () => {
    for (const amount of [0, -100]) {
      await expect(
        asTenant(client, tenant.id, async () => {
          const id = await insertEntry();
          await insertLine(id, 1, cash, 'debit', amount);
          await insertLine(id, 2, capital, 'credit', amount);
        }),
      ).rejects.toThrow(/journal_lines_positive_amount/);
    }
  });

  it('rejects adding lines to a posted entry, even a balanced pair', async () => {
    const id = await postBalanced();
    await expect(
      asTenant(client, tenant.id, async () => {
        await insertLine(id, 3, cash, 'debit', 5);
        await insertLine(id, 4, capital, 'credit', 5);
      }),
    ).rejects.toMatchObject({ code: 'LP001' });
  });

  it('gives the API role no way to update or delete posted records', async () => {
    const id = await postBalanced();
    for (const statement of [
      `UPDATE journal_entries SET description = 'changed' WHERE id = '${id}'`,
      `DELETE FROM journal_entries WHERE id = '${id}'`,
      `UPDATE journal_lines SET amount_kobo = 1 WHERE entry_id = '${id}'`,
      `DELETE FROM journal_lines WHERE entry_id = '${id}'`,
      `UPDATE audit_events SET action = 'changed'`,
      `DELETE FROM audit_events`,
      `TRUNCATE journal_lines`,
    ]) {
      await expect(asTenant(client, tenant.id, () => client.query(statement)), statement).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it('rejects posting to an inactive account', async () => {
    const account = await asTenant(client, tenant.id, async () => {
      const { rows } = await client.query(
        `INSERT INTO ledger_accounts (tenant_id, code, name, type, is_active) VALUES ($1, 'OLD', 'Closed', 'asset', false) RETURNING id`,
        [tenant.id],
      );
      return rows[0].id;
    });
    await expect(
      asTenant(client, tenant.id, async () => {
        const id = await insertEntry();
        await insertLine(id, 1, account, 'debit', 100);
        await insertLine(id, 2, capital, 'credit', 100);
      }),
    ).rejects.toMatchObject({ code: 'LP003' });
  });

  it('does not let the API role change an account type once created', async () => {
    await expect(
      asTenant(client, tenant.id, () => client.query(`UPDATE ledger_accounts SET type = 'income' WHERE id = $1`, [cash])),
    ).rejects.toThrow(/permission denied/);
  });
});
