import type { InterestMethod, LoanProductRequest, RepaymentFrequency } from '@loan-platform/api-client';

export const METHOD_LABELS: Record<InterestMethod, string> = {
  flat: 'Flat interest',
  reducing_equal_installment: 'Reducing balance, equal repayments',
  reducing_equal_principal: 'Reducing balance, equal principal',
};

export const FREQUENCY_LABELS: Record<RepaymentFrequency, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Every two weeks',
  monthly: 'Monthly',
};

export const TERM_UNITS: Record<RepaymentFrequency, string> = {
  daily: 'days',
  weekly: 'weeks',
  biweekly: 'fortnights',
  monthly: 'months',
};

export const ROUNDING_LABELS: Record<LoanProductRequest['roundingUnitKobo'], string> = {
  1: 'To the kobo',
  100: 'To the nearest ₦1',
  1000: 'To the nearest ₦10',
  10000: 'To the nearest ₦100',
};

export const BUCKET_LABELS = { penalty: 'Penalties', fee: 'Fees', interest: 'Interest', principal: 'Principal' };

export const APPLICATION_STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Waiting for decision',
  approved: 'Approved',
  rejected: 'Rejected',
};

export const LOAN_STATUS_LABELS = {
  approved: 'Waiting for disbursement',
  active: 'Active',
  closed: 'Fully repaid',
  cancelled: 'Cancelled',
};

export const DECISION_LABELS = { approved: 'Approved', rejected: 'Rejected', returned: 'Returned for changes' };
