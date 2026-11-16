import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/database.service.js';
import { users } from '../src/db/schema.js';
import { appClient, asTenant, createApp, createTenant } from './helpers.js';

describe('tenant isolation in the database', () => {
  let client: pg.Client;
  let a: Awaited<ReturnType<typeof createTenant>>;
  let b: Awaited<ReturnType<typeof createTenant>>;

  beforeAll(async () => {
    client = await appClient();
    [a, b] = await Promise.all([createTenant(), createTenant()]);
  });
  afterAll(() => client.end());

  it('runs as a role that cannot bypass row-level security', async () => {
    const { rows } = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('covers every table with a tenant_id, including any added later', async () => {
    const { rows } = await client.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relkind = 'r'`);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, policies: '1' });
    }
  });

  it('shows no rows when no tenant is set', async () => {
    for (const table of ['users', 'ledger_accounts', 'audit_events', 'tenants']) {
      const { rowCount } = await client.query(`SELECT 1 FROM ${table}`);
      expect(rowCount, table).toBe(0);
    }
  });

  it('shows a tenant only its own rows', async () => {
    const rows = await asTenant(client, a.id, async () => (await client.query('SELECT email FROM users')).rows);
    expect(rows).toEqual([{ email: a.email }]);
    const tenants = await asTenant(client, a.id, async () => (await client.query('SELECT id FROM tenants')).rows);
    expect(tenants).toEqual([{ id: a.id }]);
  });

  it('blocks writing a row for another tenant', async () => {
    await expect(
      asTenant(client, a.id, () =>
        client.query(`INSERT INTO ledger_accounts (tenant_id, code, name, type) VALUES ($1, 'X1', 'Hijack', 'asset')`, [b.id]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('blocks a composite reference into another tenant', async () => {
    const accountOfB = await asTenant(client, b.id, async () =>
      (await client.query(`SELECT id FROM ledger_accounts WHERE code = '1010'`)).rows[0].id,
    );
    await expect(
      asTenant(client, a.id, async () => {
        const user = (await client.query('SELECT id FROM users')).rows[0].id;
        const entry = await client.query(
          `INSERT INTO journal_entries (tenant_id, effective_date, description, idempotency_key, request_hash, posted_by_user_id)
           VALUES ($1, '2026-11-05', 'x', 'cross-tenant', 'h', $2) RETURNING id`,
          [a.id, user],
        );
        await client.query(
          `INSERT INTO journal_lines (tenant_id, entry_id, line_no, account_id, side, amount_kobo) VALUES ($1, $2, 1, $3, 'debit', 1)`,
          [a.id, entry.rows[0].id, accountOfB],
        );
      }),
    ).rejects.toThrow();
  });

  it('does not let tenant context leak after a transaction ends', async () => {
    await asTenant(client, a.id, async () => undefined);
    const { rowCount } = await client.query('SELECT 1 FROM users');
    expect(rowCount).toBe(0);
  });

  it('clears tenant context from a pooled connection after withTenant', async () => {
    const app = await createApp();
    const database = app.get(DatabaseService);
    const pool = (database as unknown as { pool: { query(sql: string): Promise<{ rowCount: number }> } }).pool;
    const inside = await database.withTenant(a.id, (tx) => tx.select().from(users));
    expect(inside).toHaveLength(1);
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(0);
    await app.close();
  });

  it('gives the API role no way to create tenants or read another tenant by slug beyond its id', async () => {
    await expect(client.query(`INSERT INTO tenants (slug, name) VALUES ('nope', 'Nope')`)).rejects.toThrow(/permission denied/);
    const { rows } = await client.query('SELECT app.tenant_id_by_slug($1) AS id', [a.slug]);
    expect(rows[0].id).toBe(a.id);
  });

  it('refuses to start as a role that bypasses row-level security', async () => {
    const admin = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres_dev@localhost:5432/postgres';
    const url = new URL(admin);
    url.pathname = '/loan_platform_test';
    await expect(createApp({ DATABASE_URL: url.toString() })).rejects.toThrow(/bypasses row-level security/);
  });
});
