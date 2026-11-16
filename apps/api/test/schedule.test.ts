import { describe, expect, it } from 'vitest';
import type { ProductFee } from '@loan-platform/api-client';
import { buildSchedule, type LoanTerms, ScheduleError } from '../src/modules/loan-products/schedule.js';

const terms = (overrides: Partial<LoanTerms> = {}): LoanTerms => ({
  interestMethod: 'flat',
  ratePercent: '5',
  ratePeriod: 'month',
  repaymentFrequency: 'monthly',
  periodBasis: 'simple',
  roundingUnitKobo: 1,
  fees: [],
  ...overrides,
});
const request = (naira: number, termCount: number) => ({
  principalKobo: BigInt(naira) * 100n,
  termCount,
  disbursementDate: '2026-01-15',
});
const totals = (rows: { totalKobo: string }[]) => rows.map((row) => row.totalKobo);

describe('flat interest', () => {
  it('charges interest on the original amount for the whole term', () => {
    const schedule = buildSchedule(terms(), request(100_000, 6));
    expect(schedule.totalInterestKobo).toBe('3000000');
    expect(schedule.totalRepayableKobo).toBe('13000000');
    expect(totals(schedule.installments)).toEqual([
      '2166667', '2166667', '2166667', '2166667', '2166667', '2166665',
    ]);
    expect(schedule.installments.at(-1)!.balanceAfterKobo).toBe('0');
  });

  it('puts the same interest in each installment when it divides evenly', () => {
    const schedule = buildSchedule(terms(), request(120_000, 12));
    expect(new Set(schedule.installments.map((row) => row.interestKobo))).toEqual(new Set(['600000']));
    expect(new Set(schedule.installments.map((row) => row.principalKobo))).toEqual(new Set(['1000000']));
  });

  it('rounds installments to whole naira and settles the difference at the end', () => {
    const schedule = buildSchedule(terms({ roundingUnitKobo: 100 }), request(100_000, 6));
    expect(totals(schedule.installments)).toEqual([
      '2166700', '2166700', '2166700', '2166700', '2166700', '2166500',
    ]);
    expect(schedule.totalRepayableKobo).toBe('13000000');
  });
});

describe('reducing balance', () => {
  // Expected values come from a separate exact-decimal amortisation in Python.
  it.each([
    ['1', 'month', 100_000, 12, '888488', '661853', '888485'],
    ['4.5', 'month', 250_000, 9, '3439362', '5954256', '3439360'],
    ['24', 'year', 500_000, 24, '2643555', '13445314', '2643549'],
  ] as const)('matches an independent calculation at %s%% per %s', (rate, period, naira, count, regular, interest, last) => {
    const schedule = buildSchedule(
      terms({ interestMethod: 'reducing_equal_installment', ratePercent: rate, ratePeriod: period }),
      request(naira, count),
    );
    expect(schedule.installments[0]!.totalKobo).toBe(regular);
    expect(schedule.totalInterestKobo).toBe(interest);
    expect(schedule.installments.at(-1)!.totalKobo).toBe(last);
  });

  it('keeps principal equal and lets interest fall with equal-principal loans', () => {
    const schedule = buildSchedule(
      terms({ interestMethod: 'reducing_equal_principal', ratePercent: '2' }),
      request(120_000, 3),
    );
    expect(totals(schedule.installments)).toEqual(['4240000', '4160000', '4080000']);
    expect(schedule.totalInterestKobo).toBe('480000');
  });

  it('charges less interest than flat at the same headline rate', () => {
    const flat = buildSchedule(terms(), request(100_000, 6));
    const reducing = buildSchedule(terms({ interestMethod: 'reducing_equal_installment' }), request(100_000, 6));
    expect(BigInt(reducing.totalInterestKobo)).toBeLessThan(BigInt(flat.totalInterestKobo));
  });
});

describe('repayment frequency', () => {
  it('treats a month as four weeks on the simple basis', () => {
    const schedule = buildSchedule(terms({ repaymentFrequency: 'weekly' }), request(100_000, 12));
    expect(schedule.totalInterestKobo).toBe('1500000');
  });

  it('treats a year as 52 weeks on the calendar basis', () => {
    const schedule = buildSchedule(
      terms({ repaymentFrequency: 'weekly', periodBasis: 'calendar' }),
      request(100_000, 12),
    );
    expect(schedule.totalInterestKobo).toBe('1384615');
  });

  it('supports daily and fortnightly dates', () => {
    const daily = buildSchedule(terms({ repaymentFrequency: 'daily' }), request(10_000, 3));
    expect(daily.installments.map((row) => row.dueDate)).toEqual(['2026-01-16', '2026-01-17', '2026-01-18']);
    const biweekly = buildSchedule(terms({ repaymentFrequency: 'biweekly' }), request(10_000, 2));
    expect(biweekly.installments.map((row) => row.dueDate)).toEqual(['2026-01-29', '2026-02-12']);
  });
});

describe('due dates', () => {
  it('clamps to the end of short months, then returns to the original day', () => {
    const schedule = buildSchedule(terms(), { ...request(10_000, 4), disbursementDate: '2025-12-31' });
    expect(schedule.installments.map((row) => row.dueDate)).toEqual([
      '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30',
    ]);
  });

  it('handles leap years', () => {
    const schedule = buildSchedule(terms(), { ...request(10_000, 2), disbursementDate: '2028-01-31' });
    expect(schedule.installments[0]!.dueDate).toBe('2028-02-29');
  });

  it('honours a chosen first due date', () => {
    const schedule = buildSchedule(terms(), { ...request(10_000, 2), firstDueDate: '2026-03-01' });
    expect(schedule.installments.map((row) => row.dueDate)).toEqual(['2026-03-01', '2026-04-01']);
  });

  it('rejects a first due date on or before disbursement', () => {
    expect(() => buildSchedule(terms(), { ...request(10_000, 2), firstDueDate: '2026-01-15' })).toThrow(ScheduleError);
  });
});

describe('fees', () => {
  const fee = (timing: ProductFee['timing']): ProductFee => ({
    name: 'Processing',
    type: 'percent_of_principal',
    percent: '2.5',
    timing,
  });

  it('deducts upfront fees from what the borrower receives', () => {
    const schedule = buildSchedule(terms({ fees: [fee('deducted_upfront')] }), request(100_000, 6));
    expect(schedule.upfrontFeesKobo).toBe('250000');
    expect(schedule.netDisbursedKobo).toBe('9750000');
    expect(schedule.totalRepayableKobo).toBe('13000000');
  });

  it('adds a first-installment fee to installment one only', () => {
    const schedule = buildSchedule(terms({ fees: [fee('first_installment')] }), request(100_000, 6));
    expect(schedule.installments.map((row) => row.feeKobo)).toEqual(['250000', '0', '0', '0', '0', '0']);
    expect(schedule.totalRepayableKobo).toBe('13250000');
  });

  it('spreads a fee across installments with no kobo lost', () => {
    const flatFee: ProductFee = { name: 'Admin', type: 'flat', amountKobo: '100000', timing: 'spread' };
    const schedule = buildSchedule(terms({ fees: [flatFee] }), request(100_000, 3));
    expect(schedule.installments.map((row) => row.feeKobo)).toEqual(['33333', '33334', '33333']);
    expect(schedule.totalScheduledFeesKobo).toBe('100000');
  });

  it('rejects upfront fees that swallow the loan', () => {
    const large: ProductFee = { name: 'Huge', type: 'flat', amountKobo: '100000', timing: 'deducted_upfront' };
    expect(() => buildSchedule(terms({ fees: [large] }), request(1_000, 1))).toThrow(/less than the loan amount/);
  });
});

describe('edge cases', () => {
  it('supports interest-free loans', () => {
    for (const interestMethod of ['flat', 'reducing_equal_installment', 'reducing_equal_principal'] as const) {
      const schedule = buildSchedule(terms({ interestMethod, ratePercent: '0' }), request(100_000, 3));
      expect(schedule.totalInterestKobo).toBe('0');
      expect(schedule.totalRepayableKobo).toBe('10000000');
    }
  });

  it('supports a single repayment', () => {
    const schedule = buildSchedule(terms(), request(50_000, 1));
    expect(totals(schedule.installments)).toEqual(['5250000']);
  });

  it('keeps every digit on very large loans', () => {
    const schedule = buildSchedule(terms(), {
      principalKobo: 900_000_000_000_000_000n,
      termCount: 7,
      disbursementDate: '2026-01-15',
    });
    const sum = schedule.installments.reduce((total, row) => total + BigInt(row.principalKobo), 0n);
    expect(sum).toBe(900_000_000_000_000_000n);
  });

  it('refuses a rounding unit that leaves nothing for the last installment', () => {
    const coarse = terms({ roundingUnitKobo: 10000, ratePercent: '0' });
    expect(() => buildSchedule(coarse, { ...request(1, 3), principalKobo: 16_000n })).toThrow(ScheduleError);
  });
});

describe('every generated schedule', () => {
  const pick = <T,>(values: readonly T[]) => values[Math.floor(Math.random() * values.length)]!;

  it('holds its invariants across 3,000 random loans', () => {
    let refused = 0;
    for (let run = 0; run < 3000; run += 1) {
      const loanTerms = terms({
        interestMethod: pick(['flat', 'reducing_equal_installment', 'reducing_equal_principal'] as const),
        ratePercent: `${Math.floor(Math.random() * 30)}.${String(Math.floor(Math.random() * 9999)).padStart(4, '0')}`,
        ratePeriod: pick(['month', 'year'] as const),
        repaymentFrequency: pick(['daily', 'weekly', 'biweekly', 'monthly'] as const),
        periodBasis: pick(['simple', 'calendar'] as const),
        roundingUnitKobo: pick([1, 100]),
      });
      const principal = BigInt(5_000_000 + Math.floor(Math.random() * 5e9));
      const count = 1 + Math.floor(Math.random() * 60);
      const context = JSON.stringify({ loanTerms, principal: principal.toString(), count });
      let schedule;
      try {
        schedule = buildSchedule(loanTerms, {
          principalKobo: principal,
          termCount: count,
          disbursementDate: '2026-03-31',
        });
      } catch (error) {
        // Near 30% a month over 5 years the first repayment is almost all interest, so rounding
        // it can tip the balance upward. The calculator refuses instead of showing a bad schedule.
        expect(error, context).toBeInstanceOf(ScheduleError);
        expect(loanTerms.interestMethod, context).toBe('reducing_equal_installment');
        refused += 1;
        continue;
      }
      const rows = schedule.installments;

      expect(rows, context).toHaveLength(count);
      expect(rows.reduce((sum, row) => sum + BigInt(row.principalKobo), 0n), context).toBe(principal);
      expect(rows.reduce((sum, row) => sum + BigInt(row.totalKobo), 0n).toString(), context).toBe(
        schedule.totalRepayableKobo,
      );
      expect(rows.at(-1)!.balanceAfterKobo, context).toBe('0');
      let previous = principal;
      for (const row of rows) {
        const balance = BigInt(row.balanceAfterKobo);
        expect(balance, context).toBeLessThanOrEqual(previous);
        expect(BigInt(row.interestKobo), context).toBeGreaterThanOrEqual(0n);
        previous = balance;
      }
      for (let index = 1; index < count; index += 1) {
        expect(rows[index]!.dueDate > rows[index - 1]!.dueDate, context).toBe(true);
      }
    }
    expect(refused).toBeLessThan(150);
  });

  it('never refuses a realistic loan', () => {
    for (const interestMethod of ['flat', 'reducing_equal_installment', 'reducing_equal_principal'] as const) {
      for (const ratePercent of ['0', '1', '2.5', '5', '7.5', '10']) {
        for (const roundingUnitKobo of [1, 100, 1000]) {
          for (const count of [1, 2, 3, 6, 12, 24, 36]) {
            const loanTerms = terms({ interestMethod, ratePercent, roundingUnitKobo });
            expect(() => buildSchedule(loanTerms, request(10_000, count))).not.toThrow();
          }
        }
      }
    }
  });
});
