import { describe, expect, it } from 'vitest';
import { allocatePayment, type OpenInstallment } from '../src/modules/loans/allocation.js';

const installment = (id: string, interest: bigint, principal: bigint, fee = 0n, penalty = 0n): OpenInstallment => ({
  id,
  remaining: { penalty, fee, interest, principal },
});
const standard = ['penalty', 'fee', 'interest', 'principal'] as const;
const simple = (rows: ReturnType<typeof allocatePayment>) => rows.map((row) => [row.scheduleItemId, row.bucket, row.amountKobo]);

describe('payment allocation', () => {
  it('follows the payment order inside an installment', () => {
    const rows = allocatePayment(650n, [installment('a', 300n, 700n, 200n, 100n)], [...standard]);
    expect(simple(rows)).toEqual([
      ['a', 'penalty', 100n],
      ['a', 'fee', 200n],
      ['a', 'interest', 300n],
      ['a', 'principal', 50n],
    ]);
  });

  it('honours a product that takes principal first', () => {
    const rows = allocatePayment(800n, [installment('a', 300n, 700n)], ['principal', 'interest', 'fee', 'penalty']);
    expect(simple(rows)).toEqual([
      ['a', 'principal', 700n],
      ['a', 'interest', 100n],
    ]);
  });

  it('clears the oldest installment before touching the next', () => {
    const rows = allocatePayment(1200n, [installment('a', 100n, 900n), installment('b', 100n, 900n)], [...standard]);
    expect(simple(rows)).toEqual([
      ['a', 'interest', 100n],
      ['a', 'principal', 900n],
      ['b', 'interest', 100n],
      ['b', 'principal', 100n],
    ]);
  });

  it('picks up where a part-paid installment left off', () => {
    const rows = allocatePayment(150n, [installment('a', 0n, 100n), installment('b', 100n, 900n)], [...standard]);
    expect(simple(rows)).toEqual([
      ['a', 'principal', 100n],
      ['b', 'interest', 50n],
    ]);
  });

  it('holds anything above the full balance as an overpayment', () => {
    const rows = allocatePayment(1300n, [installment('a', 100n, 900n)], [...standard]);
    expect(rows.at(-1)).toEqual({ scheduleItemId: null, bucket: 'overpayment', amountKobo: 300n });
  });

  it('holds and allocates every kobo across 5,000 random payments', () => {
    const big = (limit: number) => BigInt(Math.floor(Math.random() * limit));
    for (let run = 0; run < 5000; run += 1) {
      const items = Array.from({ length: 1 + Number(big(12)) }, (_, index) =>
        installment(`i${index}`, big(1e6), big(1e7), big(1e5), big(1e4)),
      );
      const owed = items.reduce(
        (sum, { remaining: r }) => sum + r.penalty + r.fee + r.interest + r.principal,
        0n,
      );
      const amount = 1n + big(Number(owed) + 2e6);
      const rows = allocatePayment(amount, items, [...standard]);
      expect(rows.reduce((sum, row) => sum + row.amountKobo, 0n)).toBe(amount);
      for (const row of rows) {
        expect(row.amountKobo).toBeGreaterThan(0n);
        if (row.bucket !== 'overpayment') {
          const item = items.find((candidate) => candidate.id === row.scheduleItemId)!;
          expect(row.amountKobo).toBeLessThanOrEqual(item.remaining[row.bucket]);
        }
      }
      const over = rows.find((row) => row.bucket === 'overpayment')?.amountKobo ?? 0n;
      expect(over).toBe(amount > owed ? amount - owed : 0n);
    }
  });
});
