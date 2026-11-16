import { describe, expect, it } from 'vitest';
import type { ProductPenalty } from '@loan-platform/api-client';
import { expectedPenalties } from '../src/modules/loans/penalties.js';

const item = (id = 'a', dueDate = '2026-03-01', totalKobo = 100_000n) => ({ id, dueDate, totalKobo });
const percent = (overrides: object = {}): ProductPenalty => ({
  type: 'percent_of_overdue',
  percent: '1',
  graceDays: 3,
  frequency: 'daily',
  ...overrides,
});
const flat = (overrides: object = {}): ProductPenalty => ({
  type: 'flat',
  amountKobo: '50000',
  graceDays: 0,
  frequency: 'once',
  ...overrides,
});
const dates = (charges: { chargeDate: string }[]) => charges.map((charge) => charge.chargeDate);

describe('late penalty rules', () => {
  it('charges nothing when a product has no penalty', () => {
    expect(expectedPenalties({ type: 'none' }, [item()], [], '2027-01-01')).toEqual([]);
  });

  it('waits for the grace period, then starts the next day', () => {
    expect(expectedPenalties(percent(), [item()], [], '2026-03-04')).toEqual([]);
    expect(dates(expectedPenalties(percent(), [item()], [], '2026-03-05'))).toEqual(['2026-03-05']);
  });

  it('starts the day after the due date with no grace', () => {
    expect(dates(expectedPenalties(percent({ graceDays: 0 }), [item()], [], '2026-03-02'))).toEqual(['2026-03-02']);
  });

  it('charges a percentage of what is unpaid and does not compound', () => {
    const charges = expectedPenalties(percent(), [item()], [], '2026-03-07');
    expect(charges.map((charge) => charge.amountKobo)).toEqual([1000n, 1000n, 1000n]);
    expect(charges.every((charge) => charge.basisKobo === 100_000n)).toBe(true);
  });

  it('uses the amount unpaid on each date', () => {
    const payments = [{ scheduleItemId: 'a', paymentDate: '2026-03-06', amountKobo: 40_000n }];
    const charges = expectedPenalties(percent(), [item()], payments, '2026-03-07');
    expect(charges.map((charge) => charge.amountKobo)).toEqual([1000n, 600n, 600n]);
  });

  it('stops once the installment is cleared', () => {
    const payments = [{ scheduleItemId: 'a', paymentDate: '2026-03-06', amountKobo: 100_000n }];
    expect(dates(expectedPenalties(percent(), [item()], payments, '2026-04-01'))).toEqual(['2026-03-05']);
  });

  it('charges nothing if paid during the grace period', () => {
    const payments = [{ scheduleItemId: 'a', paymentDate: '2026-03-03', amountKobo: 100_000n }];
    expect(expectedPenalties(percent(), [item()], payments, '2026-04-01')).toEqual([]);
  });

  it('charges a flat amount once', () => {
    const charges = expectedPenalties(flat(), [item()], [], '2026-12-31');
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ chargeDate: '2026-03-02', amountKobo: 50_000n });
  });

  it('repeats weekly and every 30 days', () => {
    expect(dates(expectedPenalties(flat({ frequency: 'weekly' }), [item()], [], '2026-03-16'))).toEqual([
      '2026-03-02',
      '2026-03-09',
      '2026-03-16',
    ]);
    expect(dates(expectedPenalties(flat({ frequency: 'monthly' }), [item()], [], '2026-04-01'))).toEqual([
      '2026-03-02',
      '2026-04-01',
    ]);
  });

  it('treats each installment separately', () => {
    const charges = expectedPenalties(flat(), [item('a', '2026-03-01'), item('b', '2026-04-01')], [], '2026-04-02');
    expect(charges.map((charge) => charge.scheduleItemId)).toEqual(['a', 'b']);
  });

  it('rounds half up to the kobo and skips a charge that rounds to nothing', () => {
    expect(expectedPenalties(percent({ percent: '0.5', graceDays: 0 }), [item('a', '2026-03-01', 101n)], [], '2026-03-02')[0]!.amountKobo).toBe(1n);
    expect(expectedPenalties(percent({ percent: '0.1', graceDays: 0 }), [item('a', '2026-03-01', 100n)], [], '2026-03-02')).toEqual([]);
  });

  it('gives the same answer however late it runs', () => {
    const early = expectedPenalties(percent(), [item()], [], '2026-03-10');
    const later = expectedPenalties(percent(), [item()], [], '2026-03-20');
    expect(later.slice(0, early.length)).toEqual(early);
  });
});
