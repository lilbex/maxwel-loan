import type {
  InterestMethod,
  LoanSchedule,
  ProductFee,
  RepaymentFrequency,
  ScheduleInstallment,
} from '@loan-platform/api-client';

/*
 * Pure loan arithmetic. Everything is exact BigInt fractions until a value is rounded to money,
 * so no result depends on floating point. Rounding is half up. The final installment always
 * settles whatever is left, so the schedule totals match to the kobo.
 */

export interface LoanTerms {
  interestMethod: InterestMethod;
  ratePercent: string;
  ratePeriod: 'month' | 'year';
  repaymentFrequency: RepaymentFrequency;
  periodBasis: 'simple' | 'calendar';
  roundingUnitKobo: number;
  fees: ProductFee[];
}

export interface ScheduleRequest {
  principalKobo: bigint;
  termCount: number;
  disbursementDate: string;
  firstDueDate?: string;
}

export class ScheduleError extends Error {}

interface Fraction {
  n: bigint;
  d: bigint;
}

const PERIODS_PER_MONTH: Record<'simple' | 'calendar', Record<RepaymentFrequency, Fraction>> = {
  simple: {
    daily: { n: 30n, d: 1n },
    weekly: { n: 4n, d: 1n },
    biweekly: { n: 2n, d: 1n },
    monthly: { n: 1n, d: 1n },
  },
  calendar: {
    daily: { n: 365n, d: 12n },
    weekly: { n: 52n, d: 12n },
    biweekly: { n: 26n, d: 12n },
    monthly: { n: 1n, d: 1n },
  },
};

const roundDiv = (n: bigint, d: bigint): bigint => (2n * n + d) / (2n * d);
const roundToUnit = (n: bigint, d: bigint, unit: bigint): bigint => roundDiv(n, d * unit) * unit;

function percentToFraction(percent: string): Fraction {
  const [whole, decimals = ''] = percent.split('.');
  return { n: BigInt(`${whole}${decimals}`), d: 100n * 10n ** BigInt(decimals.length) };
}

export function periodRate(terms: LoanTerms): Fraction {
  const rate = percentToFraction(terms.ratePercent);
  const months = terms.ratePeriod === 'year' ? 12n : 1n;
  const perMonth = PERIODS_PER_MONTH[terms.periodBasis][terms.repaymentFrequency];
  return { n: rate.n * perMonth.d, d: rate.d * months * perMonth.n };
}

/** Shares a total across n slots so that the running sum always stays within half a unit of exact. */
function evenShares(total: bigint, count: number, unit: bigint): bigint[] {
  const shares: bigint[] = [];
  let allocated = 0n;
  for (let index = 1; index <= count; index += 1) {
    const cumulative = index === count ? total : roundToUnit(total * BigInt(index), BigInt(count), unit);
    shares.push(cumulative - allocated);
    allocated = cumulative;
  }
  return shares;
}

function equalInstallment(principal: bigint, rate: Fraction, count: number, unit: bigint): bigint {
  if (rate.n === 0n) return roundToUnit(principal, BigInt(count), unit);
  const growthN = (rate.d + rate.n) ** BigInt(count);
  const growthD = rate.d ** BigInt(count);
  return roundToUnit(principal * rate.n * growthN, rate.d * (growthN - growthD), unit);
}

interface Part {
  principal: bigint;
  interest: bigint;
}

function flatParts(principal: bigint, terms: LoanTerms, count: number, unit: bigint): Part[] {
  const rate = periodRate(terms);
  const totalInterest = roundDiv(principal * rate.n * BigInt(count), rate.d);
  const installment = roundToUnit(principal + totalInterest, BigInt(count), unit);
  const interestShares = evenShares(totalInterest, count, 1n);
  let balance = principal;
  return interestShares.map((interest, index) => {
    const part = index === count - 1 ? balance : installment - interest;
    balance -= part;
    return { principal: part, interest };
  });
}

function reducingParts(principal: bigint, terms: LoanTerms, count: number, unit: bigint): Part[] {
  const rate = periodRate(terms);
  const installment = equalInstallment(principal, rate, count, unit);
  const principalShares = evenShares(principal, count, unit);
  const parts: Part[] = [];
  let balance = principal;
  for (let index = 0; index < count; index += 1) {
    const interest = roundDiv(balance * rate.n, rate.d);
    let part: bigint;
    if (index === count - 1) part = balance;
    else if (terms.interestMethod === 'reducing_equal_principal') part = principalShares[index]!;
    else part = installment - interest;
    balance -= part;
    parts.push({ principal: part, interest });
  }
  return parts;
}

function addMonthsClamped(anchor: string, months: number): string {
  const [year, month, day] = anchor.split('-').map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

function addDays(anchor: string, days: number): string {
  return new Date(Date.parse(`${anchor}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function dueDates(request: ScheduleRequest, frequency: RepaymentFrequency): string[] {
  const step = (anchor: string, periods: number): string => {
    if (frequency === 'monthly') return addMonthsClamped(anchor, periods);
    return addDays(anchor, periods * { daily: 1, weekly: 7, biweekly: 14 }[frequency]);
  };
  // Each date comes from the anchor, so a loan due on the 31st returns to the 31st after February.
  const dates = request.firstDueDate
    ? Array.from({ length: request.termCount }, (_, index) => step(request.firstDueDate!, index))
    : Array.from({ length: request.termCount }, (_, index) => step(request.disbursementDate, index + 1));
  if (dates[0]! <= request.disbursementDate) {
    throw new ScheduleError('The first due date must be after the disbursement date');
  }
  return dates;
}

export function feeAmount(fee: ProductFee, principal: bigint): bigint {
  if (fee.type === 'flat') return BigInt(fee.amountKobo);
  const rate = percentToFraction(fee.percent);
  return roundDiv(principal * rate.n, rate.d);
}

export function buildSchedule(terms: LoanTerms, request: ScheduleRequest): LoanSchedule {
  const { principalKobo: principal, termCount: count } = request;
  if (principal <= 0n) throw new ScheduleError('Loan amount must be above zero');
  if (!Number.isInteger(count) || count < 1) throw new ScheduleError('Term must be at least one installment');

  const unit = BigInt(terms.roundingUnitKobo);
  const parts =
    terms.interestMethod === 'flat'
      ? flatParts(principal, terms, count, unit)
      : reducingParts(principal, terms, count, unit);

  if (parts.some((part) => part.principal < 0n) || parts.at(-1)!.principal <= 0n) {
    throw new ScheduleError(
      'These settings cannot produce steady repayments. Use a shorter term, a lower rate or finer rounding.',
    );
  }

  const scheduledFees = Array.from({ length: count }, () => 0n);
  let upfrontFees = 0n;
  for (const fee of terms.fees) {
    const amount = feeAmount(fee, principal);
    if (fee.timing === 'deducted_upfront') upfrontFees += amount;
    else if (fee.timing === 'first_installment') scheduledFees[0]! += amount;
    else evenShares(amount, count, unit).forEach((share, index) => (scheduledFees[index]! += share));
  }
  if (upfrontFees >= principal) throw new ScheduleError('Upfront fees must be less than the loan amount');

  const dates = dueDates(request, terms.repaymentFrequency);
  let balance = principal;
  const installments: ScheduleInstallment[] = parts.map((part, index) => {
    balance -= part.principal;
    const fee = scheduledFees[index]!;
    return {
      number: index + 1,
      dueDate: dates[index]!,
      principalKobo: part.principal.toString(),
      interestKobo: part.interest.toString(),
      feeKobo: fee.toString(),
      totalKobo: (part.principal + part.interest + fee).toString(),
      balanceAfterKobo: balance.toString(),
    };
  });

  const totalInterest = parts.reduce((sum, part) => sum + part.interest, 0n);
  const totalScheduledFees = scheduledFees.reduce((sum, fee) => sum + fee, 0n);
  return {
    principalKobo: principal.toString(),
    upfrontFeesKobo: upfrontFees.toString(),
    netDisbursedKobo: (principal - upfrontFees).toString(),
    totalInterestKobo: totalInterest.toString(),
    totalScheduledFeesKobo: totalScheduledFees.toString(),
    totalRepayableKobo: (principal + totalInterest + totalScheduledFees).toString(),
    installments,
  };
}
