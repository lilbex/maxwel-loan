import { hash } from '@node-rs/argon2';
import type pg from 'pg';
import type { AccountType } from '@loan-platform/api-client';

const LENDING_READ = ['products.read', 'borrowers.read', 'loans.read'];

export const SYSTEM_ROLES: Record<string, string[]> = {
  Admin: [
    'users.read',
    'users.manage',
    'audit.read',
    'ledger.read',
    'ledger.post',
    'ledger.reverse',
    'accounts.manage',
    'products.manage',
    'borrowers.manage',
    'loans.apply',
    'loans.approve',
    'loans.disburse',
    'payments.record',
    'payments.reverse',
    'penalties.manage',
    'collections.manage',
    'reports.read',
    ...LENDING_READ,
  ],
  'Loan Officer': ['borrowers.manage', 'loans.apply', 'payments.record', 'collections.manage', ...LENDING_READ],
  Approver: ['loans.approve', 'reports.read', ...LENDING_READ],
  Accountant: [
    'audit.read',
    'ledger.read',
    'ledger.post',
    'ledger.reverse',
    'accounts.manage',
    'loans.disburse',
    'payments.record',
    'payments.reverse',
    'penalties.manage',
    'collections.manage',
    'reports.read',
    ...LENDING_READ,
  ],
  Auditor: ['users.read', 'audit.read', 'ledger.read', 'reports.read', ...LENDING_READ],
};

export const DEFAULT_CHART: [code: string, name: string, type: AccountType][] = [
  ['1000', 'Cash on hand', 'asset'],
  ['1010', 'Bank account', 'asset'],
  ['1100', 'Loans receivable: principal', 'asset'],
  ['1110', 'Loans receivable: interest', 'asset'],
  ['1120', 'Loans receivable: fees', 'asset'],
  ['1130', 'Loans receivable: penalties', 'asset'],
  ['1190', 'Allowance for loan losses', 'asset'],
  ['2000', 'Borrower overpayments', 'liability'],
  ['3000', 'Owner capital', 'equity'],
  ['3100', 'Retained earnings', 'equity'],
  ['3200', 'Opening balances', 'equity'],
  ['4000', 'Interest income', 'income'],
  ['4010', 'Fee income', 'income'],
  ['4020', 'Penalty income', 'income'],
  ['5000', 'Loan loss expense', 'expense'],
];

export interface ProvisionInput {
  slug: string;
  name: string;
  adminEmail: string;
  adminName: string;
  adminPassword: string;
}

/**
 * Runs as the migrator role, because the API role has no INSERT on tenants.
 * Tenant-owned tables still enforce RLS here, so it sets the same tenant context the API does.
 */
export async function provisionTenant(client: pg.Client, input: ProvisionInput): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.slug)) {
    throw new Error('Workspace slug must use lowercase letters, numbers and hyphens');
  }
  if (input.adminPassword.length < 12) throw new Error('Admin password must be at least 12 characters');
  const passwordHash = await hash(input.adminPassword);

  await client.query('BEGIN');
  try {
    const tenant = await client.query<{ id: string }>('INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id', [
      input.slug,
      input.name,
    ]);
    const tenantId = tenant.rows[0]!.id;
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

    const branch = await client.query<{ id: string }>(
      `INSERT INTO branches (tenant_id, name) VALUES ($1, 'Head office') RETURNING id`,
      [tenantId],
    );
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, branch_id, email, full_name, password_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, branch.rows[0]!.id, input.adminEmail.toLowerCase(), input.adminName, passwordHash],
    );

    for (const [roleName, codes] of Object.entries(SYSTEM_ROLES)) {
      const role = await client.query<{ id: string }>(
        'INSERT INTO roles (tenant_id, name, is_system) VALUES ($1, $2, true) RETURNING id',
        [tenantId, roleName],
      );
      const roleId = role.rows[0]!.id;
      for (const code of codes) {
        await client.query('INSERT INTO role_permissions (tenant_id, role_id, permission_code) VALUES ($1, $2, $3)', [
          tenantId,
          roleId,
          code,
        ]);
      }
      if (roleName === 'Admin') {
        await client.query('INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
          tenantId,
          user.rows[0]!.id,
          roleId,
        ]);
      }
    }

    for (const [code, name, type] of DEFAULT_CHART) {
      await client.query('INSERT INTO ledger_accounts (tenant_id, code, name, type) VALUES ($1, $2, $3, $4)', [
        tenantId,
        code,
        name,
        type,
      ]);
    }

    await client.query(
      `INSERT INTO audit_events (tenant_id, action, entity_type, entity_id) VALUES ($1::uuid, 'tenant.provisioned', 'tenant', $1::text)`,
      [tenantId],
    );
    await client.query('COMMIT');
    return tenantId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
