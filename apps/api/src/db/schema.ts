import { sql } from 'drizzle-orm';
import {
  type AllocationBucket,
  applicationStatuses,
  collectionOutcomes,
  type LoanTermsSnapshot,
  interestMethods,
  periodBases,
  type ProductFee,
  type ProductPenalty,
  ratePeriods,
  repaymentFrequencies,
} from '@loan-platform/api-client';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/*
 * Tenant-owned tables carry tenant_id and expose unique(tenant_id, id), so child rows use
 * composite foreign keys. A row can then never point at another tenant's row, even in code
 * that bypasses the application layer. RLS, triggers and grants live in the 0001 migration.
 */

const xid8 = customType<{ data: string }>({ dataType: () => 'xid8' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const tenantRef = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);

export const tenantStatus = pgEnum('tenant_status', ['active', 'suspended']);
export const userStatus = pgEnum('user_status', ['active', 'disabled']);
export const accountType = pgEnum('account_type', ['asset', 'liability', 'equity', 'income', 'expense']);
export const entrySide = pgEnum('entry_side', ['debit', 'credit']);
export const productStatus = pgEnum('loan_product_status', ['active', 'archived']);
export const interestMethod = pgEnum('interest_method', interestMethods);
export const ratePeriod = pgEnum('rate_period', ratePeriods);
export const repaymentFrequency = pgEnum('repayment_frequency', repaymentFrequencies);
export const periodBasis = pgEnum('period_basis', periodBases);
export const applicationStatus = pgEnum('application_status', applicationStatuses);
export const applicationDecision = pgEnum('application_decision', ['approved', 'rejected', 'returned']);
export const loanStatus = pgEnum('loan_status', ['approved', 'active', 'closed', 'cancelled']);
export const disbursementMethod = pgEnum('disbursement_method', ['cash', 'bank']);
export const collectionOutcome = pgEnum('collection_outcome', collectionOutcomes);
export const recordOrigin = pgEnum('record_origin', ['new', 'existing']);
export const allocationBucket = pgEnum('allocation_bucket', ['penalty', 'fee', 'interest', 'principal', 'overpayment']);

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  currency: text('currency').notNull().default('NGN'),
  timezone: text('timezone').notNull().default('Africa/Lagos'),
  status: tenantStatus('status').notNull().default('active'),
  createdAt: createdAt(),
});

export const branches = pgTable(
  'branches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.tenantId, t.id), unique().on(t.tenantId, t.name)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    branchId: uuid('branch_id'),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: userStatus('status').notNull().default('active'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    unique().on(t.tenantId, t.email),
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  ],
);

/** The global catalogue of what the code can check. Not tenant data. */
export const permissions = pgTable('permissions', {
  code: text('code').primaryKey(),
  description: text('description').notNull(),
});

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.tenantId, t.id), unique().on(t.tenantId, t.name)],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    tenantId: tenantRef(),
    roleId: uuid('role_id').notNull(),
    permissionCode: text('permission_code')
      .notNull()
      .references(() => permissions.code),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.roleId, t.permissionCode] }),
    foreignKey({ columns: [t.tenantId, t.roleId], foreignColumns: [roles.tenantId, roles.id] }),
  ],
);

export const userRoles = pgTable(
  'user_roles',
  {
    tenantId: tenantRef(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId, t.roleId] }),
    foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({ columns: [t.tenantId, t.roleId], foreignColumns: [roles.tenantId, roles.id] }),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id] })],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.actorUserId], foreignColumns: [users.tenantId, users.id] }),
    index().on(t.tenantId, t.createdAt.desc()),
  ],
);

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: accountType('type').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.tenantId, t.id), unique().on(t.tenantId, t.code)],
);

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    effectiveDate: date('effective_date').notNull(),
    description: text('description').notNull(),
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    reversesEntryId: uuid('reverses_entry_id'),
    postedByUserId: uuid('posted_by_user_id').notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set by trigger. Stops lines being added to an entry after its transaction has committed. */
    createdTxid: xid8('created_txid')
      .notNull()
      .default(sql`pg_current_xact_id()`),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    unique('journal_entries_idempotency_key').on(t.tenantId, t.idempotencyKey),
    unique('journal_entries_one_reversal').on(t.tenantId, t.reversesEntryId),
    foreignKey({ columns: [t.tenantId, t.reversesEntryId], foreignColumns: [t.tenantId, t.id] }),
    foreignKey({ columns: [t.tenantId, t.postedByUserId], foreignColumns: [users.tenantId, users.id] }),
    index().on(t.tenantId, t.effectiveDate),
    index().on(t.tenantId, t.sourceType, t.sourceId),
  ],
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    entryId: uuid('entry_id').notNull(),
    lineNo: integer('line_no').notNull(),
    accountId: uuid('account_id').notNull(),
    side: entrySide('side').notNull(),
    amountKobo: bigint('amount_kobo', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    unique().on(t.entryId, t.lineNo),
    check('journal_lines_positive_amount', sql`${t.amountKobo} > 0`),
    foreignKey({ columns: [t.tenantId, t.entryId], foreignColumns: [journalEntries.tenantId, journalEntries.id] }),
    foreignKey({ columns: [t.tenantId, t.accountId], foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id] }),
    index().on(t.tenantId, t.accountId),
  ],
);

/**
 * Current settings for new loans. A loan copies these terms when it is approved, so editing a
 * product never changes an existing loan.
 */
export const loanProducts = pgTable(
  'loan_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    name: text('name').notNull(),
    status: productStatus('status').notNull().default('active'),
    interestMethod: interestMethod('interest_method').notNull(),
    ratePercent: numeric('rate_percent', { precision: 7, scale: 4 }).notNull(),
    ratePeriod: ratePeriod('rate_period').notNull(),
    repaymentFrequency: repaymentFrequency('repayment_frequency').notNull(),
    periodBasis: periodBasis('period_basis').notNull(),
    minPrincipalKobo: bigint('min_principal_kobo', { mode: 'bigint' }).notNull(),
    maxPrincipalKobo: bigint('max_principal_kobo', { mode: 'bigint' }).notNull(),
    minTerm: integer('min_term').notNull(),
    maxTerm: integer('max_term').notNull(),
    roundingUnitKobo: integer('rounding_unit_kobo').notNull(),
    fees: jsonb('fees').$type<ProductFee[]>().notNull(),
    penalty: jsonb('penalty').$type<ProductPenalty>().notNull(),
    allocationOrder: jsonb('allocation_order').$type<AllocationBucket[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    unique('loan_products_name').on(t.tenantId, t.name),
    check('loan_products_rate', sql`${t.ratePercent} >= 0`),
    check('loan_products_principal_range', sql`${t.minPrincipalKobo} > 0 AND ${t.minPrincipalKobo} <= ${t.maxPrincipalKobo}`),
    check('loan_products_term_range', sql`${t.minTerm} > 0 AND ${t.minTerm} <= ${t.maxTerm}`),
  ],
);

/** Gapless per-lender numbering for the references staff read out and write down. */
export const tenantCounters = pgTable(
  'tenant_counters',
  {
    tenantId: tenantRef(),
    name: text('name').notNull(),
    value: bigint('value', { mode: 'bigint' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.name] })],
);

export const borrowers = pgTable(
  'borrowers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    reference: text('reference').notNull(),
    fullName: text('full_name').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    address: text('address').notNull(),
    businessName: text('business_name'),
    occupation: text('occupation'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    unique('borrowers_reference').on(t.tenantId, t.reference),
    unique('borrowers_phone').on(t.tenantId, t.phone),
    index().on(t.tenantId, t.fullName),
  ],
);

export const loanApplications = pgTable(
  'loan_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    reference: text('reference').notNull(),
    kind: recordOrigin('kind').notNull().default('new'),
    status: applicationStatus('status').notNull().default('draft'),
    borrowerId: uuid('borrower_id').notNull(),
    productId: uuid('product_id').notNull(),
    principalKobo: bigint('principal_kobo', { mode: 'bigint' }).notNull(),
    termCount: integer('term_count').notNull(),
    purpose: text('purpose').notNull(),
    existingDisbursementDate: date('existing_disbursement_date'),
    existingFirstDueDate: date('existing_first_due_date'),
    existingPaidKobo: bigint('existing_paid_kobo', { mode: 'bigint' }),
    paperReference: text('paper_reference'),
    preparedByUserId: uuid('prepared_by_user_id').notNull(),
    submittedByUserId: uuid('submitted_by_user_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    unique('loan_applications_reference').on(t.tenantId, t.reference),
    check('loan_applications_principal', sql`${t.principalKobo} > 0`),
    check(
      'loan_applications_existing_details',
      sql`(${t.kind} = 'existing') = (${t.existingDisbursementDate} IS NOT NULL AND ${t.existingPaidKobo} IS NOT NULL)`,
    ),
    foreignKey({ columns: [t.tenantId, t.borrowerId], foreignColumns: [borrowers.tenantId, borrowers.id] }),
    foreignKey({ columns: [t.tenantId, t.productId], foreignColumns: [loanProducts.tenantId, loanProducts.id] }),
    foreignKey({ columns: [t.tenantId, t.preparedByUserId], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({ columns: [t.tenantId, t.submittedByUserId], foreignColumns: [users.tenantId, users.id] }),
    index().on(t.tenantId, t.status),
    index().on(t.tenantId, t.borrowerId),
  ],
);

export const guarantors = pgTable(
  'guarantors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    applicationId: uuid('application_id').notNull(),
    position: integer('position').notNull(),
    fullName: text('full_name').notNull(),
    phone: text('phone').notNull(),
    address: text('address').notNull(),
    relationship: text('relationship').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.applicationId], foreignColumns: [loanApplications.tenantId, loanApplications.id] }),
    index().on(t.tenantId, t.applicationId),
  ],
);

export const collateral = pgTable(
  'collateral',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    applicationId: uuid('application_id').notNull(),
    position: integer('position').notNull(),
    description: text('description').notNull(),
    estimatedValueKobo: bigint('estimated_value_kobo', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    check('collateral_value', sql`${t.estimatedValueKobo} > 0`),
    foreignKey({ columns: [t.tenantId, t.applicationId], foreignColumns: [loanApplications.tenantId, loanApplications.id] }),
    index().on(t.tenantId, t.applicationId),
  ],
);

/** The permanent record of every decision on an application. Append-only. */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    applicationId: uuid('application_id').notNull(),
    decision: applicationDecision('decision').notNull(),
    note: text('note'),
    decidedByUserId: uuid('decided_by_user_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.applicationId], foreignColumns: [loanApplications.tenantId, loanApplications.id] }),
    foreignKey({ columns: [t.tenantId, t.decidedByUserId], foreignColumns: [users.tenantId, users.id] }),
    index().on(t.tenantId, t.applicationId),
  ],
);

export const loans = pgTable(
  'loans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    reference: text('reference').notNull(),
    applicationId: uuid('application_id').notNull(),
    borrowerId: uuid('borrower_id').notNull(),
    origin: recordOrigin('origin').notNull().default('new'),
    status: loanStatus('status').notNull().default('approved'),
    principalKobo: bigint('principal_kobo', { mode: 'bigint' }).notNull(),
    termCount: integer('term_count').notNull(),
    terms: jsonb('terms').$type<LoanTermsSnapshot>().notNull(),
    preparedByUserId: uuid('prepared_by_user_id').notNull(),
    approvedByUserId: uuid('approved_by_user_id').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
    disbursementDate: date('disbursement_date'),
    disbursementMethod: disbursementMethod('disbursement_method'),
    disbursementReference: text('disbursement_reference'),
    disbursedByUserId: uuid('disbursed_by_user_id'),
    disbursementEntryId: uuid('disbursement_entry_id'),
    /** A loan moved from paper is only charged penalties for lateness after this date. */
    penaltiesAfter: date('penalties_after'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    unique('loans_reference').on(t.tenantId, t.reference),
    unique('loans_one_per_application').on(t.tenantId, t.applicationId),
    check('loans_maker_checker', sql`${t.approvedByUserId} <> ${t.preparedByUserId}`),
    check('loans_principal', sql`${t.principalKobo} > 0`),
    check(
      'loans_active_is_disbursed',
      sql`${t.status} <> 'active' OR (${t.disbursementEntryId} IS NOT NULL AND ${t.disbursementDate} IS NOT NULL)`,
    ),
    foreignKey({ columns: [t.tenantId, t.applicationId], foreignColumns: [loanApplications.tenantId, loanApplications.id] }),
    foreignKey({ columns: [t.tenantId, t.borrowerId], foreignColumns: [borrowers.tenantId, borrowers.id] }),
    foreignKey({ columns: [t.tenantId, t.preparedByUserId], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({ columns: [t.tenantId, t.approvedByUserId], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({ columns: [t.tenantId, t.disbursedByUserId], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({ columns: [t.tenantId, t.disbursementEntryId], foreignColumns: [journalEntries.tenantId, journalEntries.id] }),
    index().on(t.tenantId, t.status),
    index().on(t.tenantId, t.borrowerId),
  ],
);

/** The repayment plan. Append-only: repayments are recorded separately and never change it. */
export const scheduleItems = pgTable(
  'schedule_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    loanId: uuid('loan_id').notNull(),
    number: integer('number').notNull(),
    dueDate: date('due_date').notNull(),
    principalKobo: bigint('principal_kobo', { mode: 'bigint' }).notNull(),
    interestKobo: bigint('interest_kobo', { mode: 'bigint' }).notNull(),
    feeKobo: bigint('fee_kobo', { mode: 'bigint' }).notNull(),
    totalKobo: bigint('total_kobo', { mode: 'bigint' }).notNull(),
    balanceAfterKobo: bigint('balance_after_kobo', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    unique('schedule_items_number').on(t.tenantId, t.loanId, t.number),
    check('schedule_items_total', sql`${t.totalKobo} = ${t.principalKobo} + ${t.interestKobo} + ${t.feeKobo}`),
    foreignKey({ columns: [t.tenantId, t.loanId], foreignColumns: [loans.tenantId, loans.id] }),
    index().on(t.tenantId, t.dueDate),
  ],
);

/**
 * Every repayment, and every correction of one, as an append-only record. A correction is a new
 * row pointing at the payment it cancels, so the history of what happened is never lost.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    reference: text('reference').notNull(),
    loanId: uuid('loan_id').notNull(),
    amountKobo: bigint('amount_kobo', { mode: 'bigint' }).notNull(),
    paymentDate: date('payment_date').notNull(),
    method: disbursementMethod('method').notNull(),
    externalReference: text('external_reference'),
    note: text('note'),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    reversesPaymentId: uuid('reverses_payment_id'),
    /** The paper total at move-in. No cash moved here, so it stays out of money collected. */
    isOpening: boolean('is_opening').notNull().default(false),
    balanceAfterKobo: bigint('balance_after_kobo', { mode: 'bigint' }).notNull(),
    journalEntryId: uuid('journal_entry_id').notNull(),
    recordedByUserId: uuid('recorded_by_user_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    unique('payments_reference').on(t.tenantId, t.reference),
    unique('payments_idempotency_key').on(t.tenantId, t.idempotencyKey),
    unique('payments_one_reversal').on(t.tenantId, t.reversesPaymentId),
    check('payments_amount', sql`${t.amountKobo} > 0`),
    foreignKey({ columns: [t.tenantId, t.loanId], foreignColumns: [loans.tenantId, loans.id] }),
    foreignKey({ columns: [t.tenantId, t.reversesPaymentId], foreignColumns: [t.tenantId, t.id] }),
    foreignKey({ columns: [t.tenantId, t.journalEntryId], foreignColumns: [journalEntries.tenantId, journalEntries.id] }),
    foreignKey({ columns: [t.tenantId, t.recordedByUserId], foreignColumns: [users.tenantId, users.id] }),
    index().on(t.tenantId, t.loanId),
    index().on(t.tenantId, t.createdAt.desc()),
  ],
);

/** Where each payment went. schedule_item_id is empty only for overpayments. */
export const paymentAllocations = pgTable(
  'payment_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    paymentId: uuid('payment_id').notNull(),
    scheduleItemId: uuid('schedule_item_id'),
    bucket: allocationBucket('bucket').notNull(),
    amountKobo: bigint('amount_kobo', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    check('payment_allocations_amount', sql`${t.amountKobo} > 0`),
    check(
      'payment_allocations_item',
      sql`(${t.bucket} = 'overpayment') = (${t.scheduleItemId} IS NULL)`,
    ),
    foreignKey({ columns: [t.tenantId, t.paymentId], foreignColumns: [payments.tenantId, payments.id] }),
    foreignKey({ columns: [t.tenantId, t.scheduleItemId], foreignColumns: [scheduleItems.tenantId, scheduleItems.id] }),
    index().on(t.tenantId, t.paymentId),
  ],
);

/**
 * One late charge on one installment on one date. The unique key makes the daily job safe to
 * repeat. Income comes from paying a charge, so a charge alone touches no ledger account.
 */
export const penaltyCharges = pgTable(
  'penalty_charges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    loanId: uuid('loan_id').notNull(),
    scheduleItemId: uuid('schedule_item_id').notNull(),
    chargeDate: date('charge_date').notNull(),
    amountKobo: bigint('amount_kobo', { mode: 'bigint' }).notNull(),
    basisKobo: bigint('basis_kobo', { mode: 'bigint' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('penalty_charges_once_a_day').on(t.tenantId, t.scheduleItemId, t.chargeDate),
    check('penalty_charges_amount', sql`${t.amountKobo} > 0`),
    foreignKey({ columns: [t.tenantId, t.loanId], foreignColumns: [loans.tenantId, loans.id] }),
    foreignKey({ columns: [t.tenantId, t.scheduleItemId], foreignColumns: [scheduleItems.tenantId, scheduleItems.id] }),
    index().on(t.tenantId, t.loanId),
  ],
);

export const penaltyWaivers = pgTable(
  'penalty_waivers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    loanId: uuid('loan_id').notNull(),
    scheduleItemId: uuid('schedule_item_id').notNull(),
    amountKobo: bigint('amount_kobo', { mode: 'bigint' }).notNull(),
    waivedOn: date('waived_on').notNull(),
    reason: text('reason').notNull(),
    waivedByUserId: uuid('waived_by_user_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('penalty_waivers_amount', sql`${t.amountKobo} > 0`),
    foreignKey({ columns: [t.tenantId, t.loanId], foreignColumns: [loans.tenantId, loans.id] }),
    foreignKey({ columns: [t.tenantId, t.scheduleItemId], foreignColumns: [scheduleItems.tenantId, scheduleItems.id] }),
    foreignKey({ columns: [t.tenantId, t.waivedByUserId], foreignColumns: [users.tenantId, users.id] }),
    index().on(t.tenantId, t.loanId),
  ],
);

export const collectionNotes = pgTable(
  'collection_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    loanId: uuid('loan_id').notNull(),
    outcome: collectionOutcome('outcome').notNull(),
    note: text('note').notNull(),
    promisedDate: date('promised_date'),
    promisedAmountKobo: bigint('promised_amount_kobo', { mode: 'bigint' }),
    recordedByUserId: uuid('recorded_by_user_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.loanId], foreignColumns: [loans.tenantId, loans.id] }),
    foreignKey({ columns: [t.tenantId, t.recordedByUserId], foreignColumns: [users.tenantId, users.id] }),
    index().on(t.tenantId, t.loanId, t.createdAt.desc()),
  ],
);
