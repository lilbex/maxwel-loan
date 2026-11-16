import { z } from 'zod';

/** Money crosses the API as a string of whole kobo, because kobo totals can exceed Number.MAX_SAFE_INTEGER. */
export const kobo = z
  .string()
  .regex(/^[1-9]\d{0,17}$/, 'Amount must be a positive whole number of kobo, sent as a string');

export const isoDate = z.iso.date();

export const loginRequest = z.strictObject({
  workspace: z.string().trim().toLowerCase().min(1).max(63),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const createUserRequest = z.strictObject({
  email: z.email().trim().toLowerCase(),
  fullName: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(256),
  roleNames: z.array(z.string().min(1)).min(1),
  branchId: z.uuid().optional(),
});
export type CreateUserRequest = z.infer<typeof createUserRequest>;

export const accountTypes = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof accountTypes)[number];

export const createAccountRequest = z.strictObject({
  code: z.string().trim().regex(/^[0-9A-Za-z-]{1,20}$/),
  name: z.string().trim().min(2).max(120),
  type: z.enum(accountTypes),
});
export type CreateAccountRequest = z.infer<typeof createAccountRequest>;

export const journalLineInput = z.strictObject({
  accountCode: z.string().min(1),
  side: z.enum(['debit', 'credit']),
  amountKobo: kobo,
});
export type JournalLineInput = z.infer<typeof journalLineInput>;

export const postEntryRequest = z.strictObject({
  effectiveDate: isoDate,
  description: z.string().trim().min(3).max(500),
  sourceType: z.string().trim().min(1).max(50).optional(),
  sourceId: z.string().trim().min(1).max(100).optional(),
  lines: z.array(journalLineInput).min(2).max(100),
});
export type PostEntryRequest = z.infer<typeof postEntryRequest>;

export const reverseEntryRequest = z.strictObject({
  effectiveDate: isoDate,
  reason: z.string().trim().min(3).max(500),
});
export type ReverseEntryRequest = z.infer<typeof reverseEntryRequest>;

export interface Me {
  user: { id: string; email: string; fullName: string };
  tenant: { id: string; slug: string; name: string; currency: string; timezone: string };
  permissions: string[];
}

export interface JournalEntry {
  id: string;
  effectiveDate: string;
  description: string;
  sourceType: string | null;
  sourceId: string | null;
  reversesEntryId: string | null;
  postedByUserId: string;
  postedAt: string;
  lines: { lineNo: number; accountCode: string; accountName: string; side: 'debit' | 'credit'; amountKobo: string }[];
}

export interface LedgerAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  isActive: boolean;
}

export interface TrialBalance {
  asOf: string;
  rows: { code: string; name: string; type: AccountType; debitKobo: string; creditKobo: string; balanceKobo: string }[];
  totalDebitKobo: string;
  totalCreditKobo: string;
  balanced: boolean;
}

export interface AuditEvent {
  id: string;
  action: string;
  actorName: string | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
}

/** Formats kobo as naira without passing through a float. */
export function formatNaira(koboAmount: string): string {
  const negative = koboAmount.startsWith('-');
  const digits = (negative ? koboAmount.slice(1) : koboAmount).padStart(3, '0');
  const naira = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}₦${naira}.${digits.slice(-2)}`;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Forwarded by server components, which have no browser cookie jar. */
  cookie?: string;
}

export function createApiClient({ baseUrl, cookie }: ApiClientOptions) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string | string[] } | null;
      const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
      throw new ApiError(response.status, message ?? `Request failed with status ${response.status}`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  return {
    login: (body: LoginRequest) => request<Me>('/auth/login', { method: 'POST', body: JSON.stringify(body) }),
    logout: () => request<void>('/auth/logout', { method: 'POST' }),
    me: () => request<Me>('/auth/me'),
    trialBalance: (asOf?: string) =>
      request<TrialBalance>(`/ledger/trial-balance${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`),
    accounts: () => request<LedgerAccount[]>('/ledger/accounts'),
    auditEvents: (limit = 20) => request<AuditEvent[]>(`/audit-events?limit=${limit}`),
    loanProducts: () => request<LoanProduct[]>('/loan-products'),
    loanProduct: (id: string) => request<LoanProduct>(`/loan-products/${id}`),
    createLoanProduct: (body: LoanProductRequest) =>
      request<LoanProduct>('/loan-products', { method: 'POST', body: JSON.stringify(body) }),
    updateLoanProduct: (id: string, body: LoanProductRequest) =>
      request<LoanProduct>(`/loan-products/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    setLoanProductStatus: (id: string, status: 'active' | 'archived') =>
      request<LoanProduct>(`/loan-products/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
    borrowers: (search = '') => request<Borrower[]>(`/borrowers?search=${encodeURIComponent(search)}`),
    borrower: (id: string) => request<Borrower>(`/borrowers/${id}`),
    createBorrower: (body: BorrowerRequest) =>
      request<Borrower>('/borrowers', { method: 'POST', body: JSON.stringify(body) }),
    updateBorrower: (id: string, body: BorrowerRequest) =>
      request<Borrower>(`/borrowers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    applications: (filter: { status?: ApplicationStatus; borrowerId?: string } = {}) =>
      request<ApplicationSummary[]>(`/loan-applications?${new URLSearchParams(filter)}`),
    application: (id: string) => request<LoanApplication>(`/loan-applications/${id}`),
    createApplication: (body: LoanApplicationRequest) =>
      request<LoanApplication>('/loan-applications', { method: 'POST', body: JSON.stringify(body) }),
    updateApplication: (id: string, body: LoanApplicationRequest) =>
      request<LoanApplication>(`/loan-applications/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    submitApplication: (id: string) => request<LoanApplication>(`/loan-applications/${id}/submit`, { method: 'POST' }),
    decideApplication: (id: string, body: DecisionRequest) =>
      request<LoanApplication>(`/loan-applications/${id}/decision`, { method: 'POST', body: JSON.stringify(body) }),
    loans: (filter: { borrowerId?: string } = {}) => request<LoanSummary[]>(`/loans?${new URLSearchParams(filter)}`),
    loan: (id: string) => request<Loan>(`/loans/${id}`),
    disburseLoan: (id: string, body: DisburseRequest) =>
      request<Loan>(`/loans/${id}/disburse`, { method: 'POST', body: JSON.stringify(body) }),
    cancelLoan: (id: string) => request<Loan>(`/loans/${id}/cancel`, { method: 'POST' }),
    staff: () => request<StaffMember[]>('/users'),
    roles: () => request<string[]>('/users/roles'),
    createStaff: (body: CreateUserRequest) =>
      request<StaffMember>('/users', { method: 'POST', body: JSON.stringify(body) }),
    recordPayment: (loanId: string, idempotencyKey: string, body: RecordPaymentRequest) =>
      request<PaymentDetail>(`/loans/${loanId}/payments`, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body),
      }),
    payments: () => request<PaymentSummary[]>('/payments'),
    payment: (id: string) => request<PaymentDetail>(`/payments/${id}`),
    reversePayment: (id: string, idempotencyKey: string, body: ReversePaymentRequest) =>
      request<PaymentDetail>(`/payments/${id}/reverse`, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body),
      }),
    statement: (loanId: string) => request<LoanStatement>(`/loans/${loanId}/statement`),
    waivePenalty: (loanId: string, body: WaivePenaltyRequest) =>
      request<Loan>(`/loans/${loanId}/penalty-waivers`, { method: 'POST', body: JSON.stringify(body) }),
    addCollectionNote: (loanId: string, body: CollectionNoteRequest) =>
      request<CollectionNote>(`/loans/${loanId}/collection-notes`, { method: 'POST', body: JSON.stringify(body) }),
    collections: () => request<CollectionsReport>('/collections'),
    applyPenalties: () => request<PenaltyRunResult>('/collections/apply-penalties', { method: 'POST' }),
    portfolioReport: () => request<PortfolioReport>('/reports/portfolio'),
    collectedReport: (from: string, to: string) =>
      request<CollectedReport>(`/reports/collected?${new URLSearchParams({ from, to })}`),
    disbursementsReport: (from: string, to: string) =>
      request<DisbursementsReport>(`/reports/disbursements?${new URLSearchParams({ from, to })}`),
    financialsReport: (from: string, to: string) =>
      request<FinancialsReport>(`/reports/financials?${new URLSearchParams({ from, to })}`),
    previewExistingLoan: (body: ExistingLoanRequest) =>
      request<ExistingLoanPreview>('/loan-applications/existing/preview', { method: 'POST', body: JSON.stringify(body) }),
    createExistingLoan: (body: ExistingLoanRequest) =>
      request<LoanApplication>('/loan-applications/existing', { method: 'POST', body: JSON.stringify(body) }),
    updateExistingLoan: (id: string, body: ExistingLoanRequest) =>
      request<LoanApplication>(`/loan-applications/existing/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    openingSummary: () => request<OpeningSummary>('/loans/opening-summary'),
    recordOpeningCash: (idempotencyKey: string, body: OpeningCashRequest) =>
      request<JournalEntry>('/ledger/opening-cash', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body),
      }),
    previewSchedule: (id: string, body: SchedulePreviewRequest) =>
      request<LoanSchedule>(`/loan-products/${id}/schedule-preview`, { method: 'POST', body: JSON.stringify(body) }),
  };
}

export const interestMethods = ['flat', 'reducing_equal_installment', 'reducing_equal_principal'] as const;
export type InterestMethod = (typeof interestMethods)[number];
export const ratePeriods = ['month', 'year'] as const;
export const repaymentFrequencies = ['daily', 'weekly', 'biweekly', 'monthly'] as const;
export type RepaymentFrequency = (typeof repaymentFrequencies)[number];
/** simple: a month is 30 days, 4 weeks or 2 fortnights. calendar: a year is 365 days, 52 weeks or 26 fortnights. */
export const periodBases = ['simple', 'calendar'] as const;
export const roundingUnits = [1, 100, 1000, 10000] as const;
export const allocationBuckets = ['penalty', 'fee', 'interest', 'principal'] as const;
export type AllocationBucket = (typeof allocationBuckets)[number];

const percent = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Enter a percentage with up to 4 decimal places');
const penaltyTiming = {
  graceDays: z.number().int().min(0).max(365),
  frequency: z.enum(['once', 'daily', 'weekly', 'monthly']),
};

export const productFee = z.discriminatedUnion('type', [
  z.strictObject({
    name: z.string().trim().min(2).max(60),
    type: z.literal('flat'),
    amountKobo: kobo,
    timing: z.enum(['deducted_upfront', 'first_installment', 'spread']),
  }),
  z.strictObject({
    name: z.string().trim().min(2).max(60),
    type: z.literal('percent_of_principal'),
    percent,
    timing: z.enum(['deducted_upfront', 'first_installment', 'spread']),
  }),
]);
export type ProductFee = z.infer<typeof productFee>;

export const productPenalty = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('none') }),
  z.strictObject({ type: z.literal('flat'), amountKobo: kobo, ...penaltyTiming }),
  z.strictObject({ type: z.literal('percent_of_overdue'), percent, ...penaltyTiming }),
]);
export type ProductPenalty = z.infer<typeof productPenalty>;

export const loanProductRequest = z
  .strictObject({
    name: z.string().trim().min(2).max(120),
    interestMethod: z.enum(interestMethods),
    ratePercent: percent,
    ratePeriod: z.enum(ratePeriods),
    repaymentFrequency: z.enum(repaymentFrequencies),
    periodBasis: z.enum(periodBases),
    minPrincipalKobo: kobo,
    maxPrincipalKobo: kobo,
    minTerm: z.number().int().min(1).max(730),
    maxTerm: z.number().int().min(1).max(730),
    roundingUnitKobo: z.union(roundingUnits.map((unit) => z.literal(unit))),
    fees: z.array(productFee).max(10),
    penalty: productPenalty,
    allocationOrder: z.array(z.enum(allocationBuckets)).length(4),
  })
  .refine((value) => BigInt(value.minPrincipalKobo) <= BigInt(value.maxPrincipalKobo), {
    path: ['maxPrincipalKobo'],
    message: 'Maximum amount must not be below the minimum',
  })
  .refine((value) => value.minTerm <= value.maxTerm, {
    path: ['maxTerm'],
    message: 'Maximum term must not be below the minimum',
  })
  .refine((value) => new Set(value.allocationOrder).size === 4, {
    path: ['allocationOrder'],
    message: 'Allocation order must list penalty, fee, interest and principal once each',
  });
export type LoanProductRequest = z.infer<typeof loanProductRequest>;

export const productStatusRequest = z.strictObject({ status: z.enum(['active', 'archived']) });

export const schedulePreviewRequest = z.strictObject({
  principalKobo: kobo,
  termCount: z.number().int().min(1).max(730),
  disbursementDate: isoDate,
  firstDueDate: isoDate.optional(),
});
export type SchedulePreviewRequest = z.infer<typeof schedulePreviewRequest>;

export interface LoanProduct extends LoanProductRequest {
  id: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleInstallment {
  number: number;
  dueDate: string;
  principalKobo: string;
  interestKobo: string;
  feeKobo: string;
  totalKobo: string;
  balanceAfterKobo: string;
}

export interface LoanSchedule {
  principalKobo: string;
  upfrontFeesKobo: string;
  netDisbursedKobo: string;
  totalInterestKobo: string;
  totalScheduledFeesKobo: string;
  totalRepayableKobo: string;
  installments: ScheduleInstallment[];
}

/** Converts a naira amount typed by staff into kobo without passing through a float. */
export function nairaToKobo(value: string): string | null {
  const match = /^(\d{1,16})(?:\.(\d{1,2}))?$/.exec(value.replaceAll(',', '').trim());
  if (!match) return null;
  return (BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))).toString();
}

const phone = z.string().trim().regex(/^\+?[0-9][0-9 ()-]{6,19}$/, 'Enter a valid phone number');

export const borrowerRequest = z.strictObject({
  fullName: z.string().trim().min(2).max(120),
  phone,
  email: z.email().trim().toLowerCase().optional(),
  address: z.string().trim().min(3).max(300),
  businessName: z.string().trim().max(120).optional(),
  occupation: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type BorrowerRequest = z.infer<typeof borrowerRequest>;

export interface Borrower extends BorrowerRequest {
  id: string;
  reference: string;
  createdAt: string;
}

export const guarantorInput = z.strictObject({
  fullName: z.string().trim().min(2).max(120),
  phone,
  address: z.string().trim().min(3).max(300),
  relationship: z.string().trim().min(2).max(60),
});
export type GuarantorInput = z.infer<typeof guarantorInput>;

export const collateralInput = z.strictObject({
  description: z.string().trim().min(3).max(300),
  estimatedValueKobo: kobo,
});
export type CollateralInput = z.infer<typeof collateralInput>;

export const loanApplicationRequest = z.strictObject({
  borrowerId: z.uuid(),
  productId: z.uuid(),
  principalKobo: kobo,
  termCount: z.number().int().min(1).max(730),
  purpose: z.string().trim().min(3).max(500),
  guarantors: z.array(guarantorInput).max(5),
  collateral: z.array(collateralInput).max(10),
});
export type LoanApplicationRequest = z.infer<typeof loanApplicationRequest>;

export const applicationStatuses = ['draft', 'submitted', 'approved', 'rejected'] as const;
export type ApplicationStatus = (typeof applicationStatuses)[number];

export const decisionRequest = z
  .strictObject({
    decision: z.enum(['approved', 'rejected', 'returned']),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((value) => value.decision === 'approved' || (value.note?.length ?? 0) >= 3, {
    path: ['note'],
    message: 'Give a reason when rejecting or returning an application',
  });
export type DecisionRequest = z.infer<typeof decisionRequest>;

export interface ApplicationSummary {
  id: string;
  reference: string;
  kind: 'new' | 'existing';
  status: ApplicationStatus;
  borrowerId: string;
  borrowerName: string;
  productId: string;
  productName: string;
  principalKobo: string;
  termCount: number;
  createdAt: string;
}

export interface ApplicationDecision {
  decision: DecisionRequest['decision'];
  note: string | null;
  decidedByName: string;
  createdAt: string;
}

export interface LoanApplication extends ApplicationSummary {
  purpose: string;
  preparedByUserId: string;
  preparedByName: string;
  submittedByUserId: string | null;
  guarantors: GuarantorInput[];
  collateral: CollateralInput[];
  decisions: ApplicationDecision[];
  loanId: string | null;
  /** Set when this records a loan already running on paper rather than a new request. */
  existing: ExistingLoanDetails | null;
}

/** Copied onto a loan at approval. Later product changes never reach it. */
export type LoanTermsSnapshot = Pick<
  LoanProduct,
  | 'name'
  | 'interestMethod'
  | 'ratePercent'
  | 'ratePeriod'
  | 'repaymentFrequency'
  | 'periodBasis'
  | 'roundingUnitKobo'
  | 'fees'
  | 'penalty'
  | 'allocationOrder'
>;

export const disburseRequest = z.strictObject({
  disbursementDate: isoDate,
  firstDueDate: isoDate.optional(),
  method: z.enum(['cash', 'bank']),
  reference: z.string().trim().max(100).optional(),
});
export type DisburseRequest = z.infer<typeof disburseRequest>;

export type LoanStatus = 'approved' | 'active' | 'closed' | 'cancelled';

export interface LoanSummary {
  id: string;
  reference: string;
  origin: 'new' | 'existing';
  status: LoanStatus;
  borrowerId: string;
  borrowerName: string;
  productName: string;
  principalKobo: string;
  termCount: number;
  disbursementDate: string | null;
}

export interface Loan extends LoanSummary {
  applicationId: string;
  terms: LoanTermsSnapshot;
  approvedByName: string;
  approvedAt: string;
  disbursementMethod: DisburseRequest['method'] | null;
  disbursementReference: string | null;
  disbursementEntryId: string | null;
  installments: LoanInstallment[];
  outstanding: LoanOutstanding;
  payments: PaymentSummary[];
  notes: CollectionNote[];
}

export interface StaffMember {
  id: string;
  email: string;
  fullName: string;
  status: 'active' | 'disabled';
  roles: string[];
}

export const recordPaymentRequest = z.strictObject({
  amountKobo: kobo,
  paymentDate: isoDate,
  method: z.enum(['cash', 'bank']),
  reference: z.string().trim().max(100).optional(),
  note: z.string().trim().max(500).optional(),
});
export type RecordPaymentRequest = z.infer<typeof recordPaymentRequest>;

export const reversePaymentRequest = z.strictObject({ reason: z.string().trim().min(3).max(500) });
export type ReversePaymentRequest = z.infer<typeof reversePaymentRequest>;

export type InstallmentStatus = 'paid' | 'part_paid' | 'overdue' | 'due';

export interface LoanInstallment extends ScheduleInstallment {
  paidKobo: string;
  penaltyOwedKobo: string;
  status: InstallmentStatus;
}

export interface LoanOutstanding {
  principalKobo: string;
  interestKobo: string;
  feeKobo: string;
  penaltyKobo: string;
  totalKobo: string;
  overdueKobo: string;
  paidKobo: string;
  overpaymentKobo: string;
}

export interface PaymentSummary {
  id: string;
  reference: string;
  loanId: string;
  loanReference: string;
  borrowerName: string;
  amountKobo: string;
  paymentDate: string;
  method: 'cash' | 'bank';
  /** The total repaid on paper before a loan moved to this system. */
  isOpening: boolean;
  /** Set on the correcting record. */
  reversesPaymentId: string | null;
  /** Set on a payment that has been corrected. */
  reversedByPaymentId: string | null;
}

export interface PaymentDetail extends PaymentSummary {
  externalReference: string | null;
  note: string | null;
  recordedByUserId: string;
  recordedByName: string;
  recordedAt: string;
  allocation: { principalKobo: string; interestKobo: string; feeKobo: string; penaltyKobo: string; overpaymentKobo: string };
  balanceAfterKobo: string;
  journalEntryId: string;
}

export interface StatementLine {
  date: string;
  description: string;
  reference: string | null;
  chargedKobo: string;
  paidKobo: string;
  balanceKobo: string;
}

export interface LoanStatement {
  loanReference: string;
  borrowerName: string;
  borrowerReference: string;
  principalKobo: string;
  lines: StatementLine[];
  closingBalanceKobo: string;
  generatedOn: string;
}

export const waivePenaltyRequest = z.strictObject({
  amountKobo: kobo,
  reason: z.string().trim().min(3).max(500),
});
export type WaivePenaltyRequest = z.infer<typeof waivePenaltyRequest>;

export const collectionOutcomes = ['called', 'no_answer', 'promised', 'visited', 'other'] as const;
export type CollectionOutcome = (typeof collectionOutcomes)[number];

export const collectionNoteRequest = z
  .strictObject({
    outcome: z.enum(collectionOutcomes),
    note: z.string().trim().min(3).max(1000),
    promisedDate: isoDate.optional(),
    promisedAmountKobo: kobo.optional(),
  })
  .refine((value) => value.outcome !== 'promised' || value.promisedDate, {
    path: ['promisedDate'],
    message: 'Enter the date the borrower promised to pay',
  });
export type CollectionNoteRequest = z.infer<typeof collectionNoteRequest>;

export interface CollectionNote {
  id: string;
  outcome: CollectionOutcome;
  note: string;
  promisedDate: string | null;
  promisedAmountKobo: string | null;
  recordedByName: string;
  createdAt: string;
}

export interface CollectionRow {
  loanId: string;
  loanReference: string;
  borrowerId: string;
  borrowerName: string;
  borrowerPhone: string;
  dueTodayKobo: string;
  overdueKobo: string;
  outstandingKobo: string;
  daysOverdue: number;
  nextDueDate: string | null;
  nextDueKobo: string;
  lastNote: string | null;
  promisedDate: string | null;
}

export interface AgeingBucket {
  label: string;
  loans: number;
  principalKobo: string;
}

export interface CollectionsReport {
  today: string;
  activeLoans: number;
  dueTodayKobo: string;
  overdueKobo: string;
  outstandingPrincipalKobo: string;
  principalAtRiskKobo: string;
  /** Principal on loans over 30 days late, as a percentage of all outstanding principal. */
  par30Percent: string;
  ageing: AgeingBucket[];
  rows: CollectionRow[];
}

export interface PenaltyRunResult {
  loansCharged: number;
  chargesAdded: number;
}

export interface PortfolioProductRow {
  productName: string;
  activeLoans: number;
  principalOutstandingKobo: string;
  principalOverdueOver30Kobo: string;
  par30Percent: string;
}

export interface PortfolioReport {
  asOf: string;
  loansByStatus: { status: LoanStatus; loans: number }[];
  totalDisbursedKobo: string;
  principalOutstandingKobo: string;
  /** Balance of Loans receivable: principal in the ledger. Should equal principalOutstandingKobo. */
  ledgerPrincipalKobo: string;
  interestOutstandingKobo: string;
  feesOutstandingKobo: string;
  penaltiesOutstandingKobo: string;
  overdueKobo: string;
  par30Percent: string;
  products: PortfolioProductRow[];
}

export interface CollectedDay {
  date: string;
  receipts: number;
  corrections: number;
  cashKobo: string;
  bankKobo: string;
  principalKobo: string;
  interestKobo: string;
  feesKobo: string;
  penaltiesKobo: string;
  overpaymentsKobo: string;
  totalKobo: string;
}

export interface CollectedReport {
  from: string;
  to: string;
  days: CollectedDay[];
  totals: Omit<CollectedDay, 'date'>;
}

export interface DisbursementRow {
  loanId: string;
  loanReference: string;
  date: string;
  borrowerName: string;
  productName: string;
  method: 'cash' | 'bank';
  principalKobo: string;
  feesDeductedKobo: string;
  paidOutKobo: string;
}

export interface DisbursementsReport {
  from: string;
  to: string;
  rows: DisbursementRow[];
  totalPrincipalKobo: string;
  totalFeesDeductedKobo: string;
  totalPaidOutKobo: string;
}

export interface FinancialLine {
  code: string;
  name: string;
  amountKobo: string;
}

export interface FinancialsReport {
  from: string;
  to: string;
  income: FinancialLine[];
  expenses: FinancialLine[];
  totalIncomeKobo: string;
  totalExpensesKobo: string;
  profitKobo: string;
  assets: FinancialLine[];
  liabilities: FinancialLine[];
  equity: FinancialLine[];
  earningsToDateKobo: string;
  totalAssetsKobo: string;
  totalLiabilitiesAndEquityKobo: string;
  balanced: boolean;
}

/** Amount as a plain number string for spreadsheets, with no currency sign or commas. */
export function koboToDecimal(kobo: string): string {
  const negative = kobo.startsWith('-');
  const digits = (negative ? kobo.slice(1) : kobo).padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * Builds CSV text. A spreadsheet runs any cell starting with =, +, - or @ as a formula, and
 * borrower names are typed by staff, so such text is quoted out. Plain numbers stay numbers.
 */
export function toCsv(rows: (string | number)[][]): string {
  const cell = (value: string | number) => {
    const text = String(value);
    if (/^-?\d+(\.\d+)?$/.test(text)) return text;
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  return `${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

export const existingLoanRequest = z.strictObject({
  borrowerId: z.uuid(),
  productId: z.uuid(),
  principalKobo: kobo,
  termCount: z.number().int().min(1).max(730),
  disbursementDate: isoDate,
  firstDueDate: isoDate.optional(),
  /** Total repaid before moving to this system, including interest and fees. */
  paidKobo: z.string().regex(/^\d{1,18}$/, 'Amount must be a whole number of kobo, sent as a string'),
  paperReference: z.string().trim().max(100).optional(),
});
export type ExistingLoanRequest = z.infer<typeof existingLoanRequest>;

export interface ExistingLoanPreview {
  totalRepayableKobo: string;
  paidKobo: string;
  owedKobo: string;
  principalOwedKobo: string;
  interestOwedKobo: string;
  feesOwedKobo: string;
  overdueKobo: string;
  installmentsCleared: number;
  installments: ScheduleInstallment[];
}

export interface ExistingLoanDetails {
  disbursementDate: string;
  firstDueDate: string | null;
  paidKobo: string;
  paperReference: string | null;
  preview: ExistingLoanPreview;
}

export interface OpeningLoanRow {
  loanId: string;
  loanReference: string;
  borrowerName: string;
  principalKobo: string;
  paidBeforeKobo: string;
  owedAtMoveKobo: string;
  principalAtMoveKobo: string;
}

export interface OpeningSummary {
  today: string;
  rows: OpeningLoanRow[];
  loansMoved: number;
  totalOwedKobo: string;
  totalPrincipalKobo: string;
  drafts: number;
  waitingForCheck: number;
}

export const openingCashRequest = z.strictObject({
  account: z.enum(['cash', 'bank']),
  amountKobo: kobo,
});
export type OpeningCashRequest = z.infer<typeof openingCashRequest>;
