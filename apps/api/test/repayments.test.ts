import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appClient, asTenant, createApp, createTenant, PASSWORD, signIn } from './helpers.js';

type Agent = Awaited<ReturnType<typeof signIn>>;

const product = (overrides: object = {}) => ({
  name: `Monthly ${randomUUID().slice(0, 6)}`,
  interestMethod: 'flat',
  ratePercent: '2.5',
  ratePeriod: 'month',
  repaymentFrequency: 'monthly',
  periodBasis: 'simple',
  minPrincipalKobo: '1000000',
  maxPrincipalKobo: '50000000',
  minTerm: 1,
  maxTerm: 24,
  roundingUnitKobo: 1,
  fees: [],
  penalty: { type: 'none' },
  allocationOrder: ['penalty', 'fee', 'interest', 'principal'],
  ...overrides,
});
const pay = (amountKobo: string, overrides: object = {}) => ({
  amountKobo,
  paymentDate: '2026-11-02',
  method: 'bank',
  ...overrides,
});

describe('repayments', () => {
  let app: NestExpressApplication;
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let admin: Agent;
  let officer: Agent;
  let approver: Agent;
  let accountant: Agent;
  let auditor: Agent;

  const staff = async (roleNames: string[]) => {
    const email = `${randomUUID().slice(0, 8)}@x.test`;
    await admin.post('/users').send({ email, fullName: `Staff ${email.slice(0, 4)}`, password: PASSWORD, roleNames }).expect(201);
    return signIn(app, tenant.slug, email);
  };

  /** ₦120,000 over 12 months at 2.5% flat: ₦13,000 a month, ₦3,000 of it interest. Paid out 1 Oct. */
  const activeLoan = async (productOverrides: object = {}, principalKobo = '12000000', termCount = 12) => {
    const { body: created } = await admin.post('/loan-products').send(product(productOverrides)).expect(201);
    const phone = `081${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const borrower = await officer.post('/borrowers').send({ fullName: 'Ngozi Eze', phone, address: 'Aba road' }).expect(201);
    const application = await officer
      .post('/loan-applications')
      .send({ borrowerId: borrower.body.id, productId: created.id, principalKobo, termCount, purpose: 'Stock', guarantors: [], collateral: [] })
      .expect(201);
    await officer.post(`/loan-applications/${application.body.id}/submit`).expect(200);
    const decided = await approver.post(`/loan-applications/${application.body.id}/decision`).send({ decision: 'approved' }).expect(200);
    await accountant
      .post(`/loans/${decided.body.loanId}/disburse`)
      .send({ disbursementDate: '2026-10-01', method: 'bank' })
      .expect(200);
    return decided.body.loanId as string;
  };
  const record = (agent: Agent, loanId: string, body: object, key = randomUUID()) =>
    agent.post(`/loans/${loanId}/payments`).set('Idempotency-Key', key).send(body);
  const reverse = (agent: Agent, paymentId: string, key = randomUUID()) =>
    agent.post(`/payments/${paymentId}/reverse`).set('Idempotency-Key', key).send({ reason: 'Wrong amount typed' });
  const loan = async (id: string) => (await accountant.get(`/loans/${id}`).expect(200)).body;
  const balances = async () => {
    const { body } = await accountant.get('/ledger/trial-balance').expect(200);
    expect(body.balanced).toBe(true);
    return Object.fromEntries(
      body.rows.map((row: { code: string; debitKobo: string; creditKobo: string }) => [
        row.code,
        BigInt(row.debitKobo) - BigInt(row.creditKobo),
      ]),
    ) as Record<string, bigint>;
  };
  const change = (after: Record<string, bigint>, before: Record<string, bigint>, code: string) => after[code]! - before[code]!;

  beforeAll(async () => {
    app = await createApp();
    tenant = await createTenant();
    admin = await signIn(app, tenant.slug, tenant.email);
    [officer, approver, accountant, auditor] = await Promise.all([
      staff(['Loan Officer']),
      staff(['Approver']),
      staff(['Accountant']),
      staff(['Auditor']),
    ]);
  });
  afterAll(() => app.close());

  describe('recording', () => {
    it('splits an exact installment and posts income only as it is paid', async () => {
      const id = await activeLoan();
      const before = await balances();
      const { body } = await record(officer, id, pay('1300000', { reference: 'TRF-9', note: 'Paid at branch' })).expect(201);
      expect(body.reference).toMatch(/^R-\d{5}$/);
      expect(body.allocation).toMatchObject({ interestKobo: '300000', principalKobo: '1000000', overpaymentKobo: '0' });
      expect(body.balanceAfterKobo).toBe('14300000');

      const after = await balances();
      expect(change(after, before, '1010')).toBe(1_300_000n);
      expect(change(after, before, '1100')).toBe(-1_000_000n);
      expect(change(after, before, '4000')).toBe(-300_000n);

      const state = await loan(id);
      expect(state.installments[0]).toMatchObject({ paidKobo: '1300000', status: 'paid' });
      expect(state.outstanding).toMatchObject({
        principalKobo: '11000000',
        interestKobo: '3300000',
        totalKobo: '14300000',
        paidKobo: '1300000',
      });
    });

    it('credits cash on hand for a cash payment', async () => {
      const id = await activeLoan();
      const before = await balances();
      await record(officer, id, pay('500000', { method: 'cash' })).expect(201);
      expect(change(await balances(), before, '1000')).toBe(500_000n);
    });

    it('takes interest before principal on a part payment', async () => {
      const id = await activeLoan();
      const { body } = await record(officer, id, pay('400000')).expect(201);
      expect(body.allocation).toMatchObject({ interestKobo: '300000', principalKobo: '100000' });
      const state = await loan(id);
      expect(state.installments[0]).toMatchObject({ paidKobo: '400000' });
      expect(state.installments[0].status).not.toBe('paid');
    });

    it('rolls a large payment into later installments', async () => {
      const id = await activeLoan();
      await record(officer, id, pay('3000000')).expect(201);
      const state = await loan(id);
      expect(state.installments.slice(0, 3).map((row: { paidKobo: string }) => row.paidKobo)).toEqual([
        '1300000',
        '1300000',
        '400000',
      ]);
    });

    it('applies a product’s scheduled fees and takes them as fee income', async () => {
      const id = await activeLoan({
        fees: [{ name: 'Monitoring', type: 'flat', amountKobo: '60000', timing: 'first_installment' }],
      });
      const before = await balances();
      const { body } = await record(officer, id, pay('1360000')).expect(201);
      expect(body.allocation).toMatchObject({ feeKobo: '60000', interestKobo: '300000', principalKobo: '1000000' });
      expect(change(await balances(), before, '4010')).toBe(-60_000n);
    });

    it('closes the loan at zero and refuses more payments', async () => {
      const id = await activeLoan();
      const { body } = await record(officer, id, pay('15600000')).expect(201);
      expect(body.balanceAfterKobo).toBe('0');
      const state = await loan(id);
      expect(state.status).toBe('closed');
      expect(state.outstanding.totalKobo).toBe('0');
      await record(officer, id, pay('100')).expect(409);
    });

    it('holds an overpayment as a liability, not income', async () => {
      const id = await activeLoan();
      const before = await balances();
      const { body } = await record(officer, id, pay('15700000')).expect(201);
      expect(body.allocation.overpaymentKobo).toBe('100000');
      expect(body.balanceAfterKobo).toBe('-100000');
      const after = await balances();
      expect(change(after, before, '2000')).toBe(-100_000n);
      expect(change(after, before, '4000')).toBe(-3_600_000n);
      expect((await loan(id)).outstanding.overpaymentKobo).toBe('100000');
    });

    it('balances across many irregular payments and ends at exactly zero', async () => {
      const id = await activeLoan({ interestMethod: 'reducing_equal_installment' }, '12345678', 7);
      let left = BigInt((await loan(id)).outstanding.totalKobo);
      const before = await balances();
      const principal = 12_345_678n;
      const total = left;
      while (left > 0n) {
        const amount = left < 400_000n ? left : 1n + BigInt(Math.floor(Math.random() * 3e6));
        const paid = amount > left ? left : amount;
        await record(officer, id, pay(paid.toString())).expect(201);
        left -= paid;
        expect((await loan(id)).outstanding.totalKobo).toBe(left.toString());
      }
      const after = await balances();
      expect(change(after, before, '1100')).toBe(-principal);
      expect(change(after, before, '4000')).toBe(-(total - principal));
      expect((await loan(id)).status).toBe('closed');
    });

    it('marks unpaid past installments overdue', async () => {
      const id = await activeLoan();
      const state = await loan(id);
      const today = new Date().toISOString().slice(0, 10);
      const past = state.installments.filter((row: { dueDate: string }) => row.dueDate < today);
      expect(past.length).toBeGreaterThan(0);
      expect(past[0].status).toBe('overdue');
      expect(state.outstanding.overdueKobo).toBe(String(1_300_000 * past.length));
    });

    it('rejects a future date, a date before payout, a float, and a loan not yet paid out', async () => {
      const id = await activeLoan();
      await record(officer, id, pay('100', { paymentDate: '2099-01-01' })).expect(422);
      await record(officer, id, pay('100', { paymentDate: '2026-09-30' })).expect(422);
      await record(officer, id, { ...pay('1'), amountKobo: 10.5 }).expect(400);
      await officer.post(`/loans/${id}/payments`).send(pay('100')).expect(400);
    });
  });

  describe('safety', () => {
    it('records once when the same request is retried, including at the same moment', async () => {
      const id = await activeLoan();
      const key = randomUUID();
      const responses = await Promise.all(Array.from({ length: 8 }, () => record(officer, id, pay('500000'), key)));
      expect(new Set(responses.map((response) => response.status))).toEqual(new Set([201]));
      expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
      expect((await loan(id)).outstanding.paidKobo).toBe('500000');
    });

    it('rejects a key reused for a different amount', async () => {
      const id = await activeLoan();
      const key = randomUUID();
      await record(officer, id, pay('500000'), key).expect(201);
      await record(officer, id, pay('600000'), key).expect(409);
    });

    it('allocates correctly when different payments arrive together', async () => {
      const id = await activeLoan();
      const before = await balances();
      const responses = await Promise.all(Array.from({ length: 6 }, () => record(officer, id, pay('1300000'))));
      expect(responses.map((response) => response.status)).toEqual(Array(6).fill(201));
      const state = await loan(id);
      expect(state.installments.slice(0, 6).every((row: { status: string }) => row.status === 'paid')).toBe(true);
      expect(state.outstanding.paidKobo).toBe('7800000');
      expect(change(await balances(), before, '1100')).toBe(-6_000_000n);
    });

    it('gives each lender gapless receipt numbers', async () => {
      const id = await activeLoan();
      const first = (await record(officer, id, pay('100000')).expect(201)).body.reference;
      const second = (await record(officer, id, pay('100000')).expect(201)).body.reference;
      expect(Number(second.slice(2))).toBe(Number(first.slice(2)) + 1);
    });

    it('gives the API no way to edit or delete payment records', async () => {
      const id = await activeLoan();
      const { body } = await record(officer, id, pay('100000')).expect(201);
      const client = await appClient();
      for (const statement of [
        `UPDATE payments SET amount_kobo = 1 WHERE id = '${body.id}'`,
        `DELETE FROM payments WHERE id = '${body.id}'`,
        `UPDATE payment_allocations SET amount_kobo = 1 WHERE payment_id = '${body.id}'`,
        `DELETE FROM payment_allocations WHERE payment_id = '${body.id}'`,
      ]) {
        await expect(asTenant(client, tenant.id, () => client.query(statement)), statement).rejects.toThrow(/permission denied/);
      }
      await client.end();
    });

    it('rejects a payment that is not fully allocated, at the database', async () => {
      const id = await activeLoan();
      const { body } = await record(officer, id, pay('100000')).expect(201);
      const client = await appClient();
      await expect(
        asTenant(client, tenant.id, () =>
          client.query(
            `INSERT INTO payments (tenant_id, reference, loan_id, amount_kobo, payment_date, method, idempotency_key, request_hash,
               balance_after_kobo, journal_entry_id, recorded_by_user_id)
             SELECT tenant_id, 'R-FAKE', loan_id, 999, payment_date, method, 'fake-key', 'h', 0, journal_entry_id, recorded_by_user_id
             FROM payments WHERE id = $1`,
            [body.id],
          ),
        ),
      ).rejects.toMatchObject({ code: 'LP004' });
      await client.end();
    });
  });

  describe('corrections', () => {
    it('undoes a payment in the ledger and the balance, and keeps both records', async () => {
      const id = await activeLoan();
      const before = await balances();
      const { body: payment } = await record(officer, id, pay('1300000')).expect(201);
      const { body: correction } = await reverse(accountant, payment.id).expect(201);
      expect(correction.reference).toMatch(/^RV-/);
      expect(correction.reversesPaymentId).toBe(payment.id);
      expect(correction.balanceAfterKobo).toBe('15600000');

      const after = await balances();
      for (const code of ['1010', '1100', '4000']) expect(change(after, before, code)).toBe(0n);

      const state = await loan(id);
      expect(state.outstanding).toMatchObject({ totalKobo: '15600000', paidKobo: '0' });
      expect(state.payments).toHaveLength(2);
      expect(state.payments.find((row: { id: string }) => row.id === payment.id).reversedByPaymentId).toBe(correction.id);
    });

    it('lets the same amount be re-recorded and allocated from the start', async () => {
      const id = await activeLoan();
      const { body: payment } = await record(officer, id, pay('1300000')).expect(201);
      await reverse(accountant, payment.id).expect(201);
      const { body } = await record(officer, id, pay('1000000')).expect(201);
      expect(body.allocation).toMatchObject({ interestKobo: '300000', principalKobo: '700000' });
    });

    it('stops the recorder from correcting their own payment', async () => {
      const id = await activeLoan();
      const { body } = await record(accountant, id, pay('100000')).expect(201);
      await reverse(accountant, body.id).expect(403);
      await reverse(admin, body.id).expect(201);
    });

    it('requires the right to correct', async () => {
      const id = await activeLoan();
      const { body } = await record(accountant, id, pay('100000')).expect(201);
      await reverse(officer, body.id).expect(403);
      await reverse(auditor, body.id).expect(403);
    });

    it('corrects newest first', async () => {
      const id = await activeLoan();
      const first = (await record(officer, id, pay('100000')).expect(201)).body;
      const second = (await record(officer, id, pay('100000')).expect(201)).body;
      const refused = await reverse(accountant, first.id).expect(409);
      expect(refused.body.message).toContain(second.reference);
      await reverse(accountant, second.id).expect(201);
      await reverse(accountant, first.id).expect(201);
    });

    it('corrects once, and not a correction', async () => {
      const id = await activeLoan();
      const { body: payment } = await record(officer, id, pay('100000')).expect(201);
      const key = randomUUID();
      const { body: correction } = await reverse(accountant, payment.id, key).expect(201);
      const retry = await reverse(accountant, payment.id, key).expect(201);
      expect(retry.body.id).toBe(correction.id);
      await reverse(accountant, payment.id).expect(409);
      await reverse(admin, correction.id).expect(422);
    });

    it('reopens a closed loan when its final payment is corrected', async () => {
      const id = await activeLoan();
      const { body } = await record(officer, id, pay('15600000')).expect(201);
      expect((await loan(id)).status).toBe('closed');
      await reverse(accountant, body.id).expect(201);
      expect((await loan(id)).status).toBe('active');
      await record(officer, id, pay('100000')).expect(201);
    });

    it('removes an overpayment cleanly', async () => {
      const id = await activeLoan();
      const before = await balances();
      const { body } = await record(officer, id, pay('15700000')).expect(201);
      const { body: correction } = await reverse(accountant, body.id).expect(201);
      expect(correction.balanceAfterKobo).toBe('15600000');
      expect(change(await balances(), before, '2000')).toBe(0n);
      expect((await loan(id)).outstanding.overpaymentKobo).toBe('0');
    });
  });

  describe('receipts and statements', () => {
    it('returns a receipt with who recorded it', async () => {
      const id = await activeLoan();
      const { body } = await record(officer, id, pay('100000', { reference: 'POS-1' })).expect(201);
      const receipt = await auditor.get(`/payments/${body.id}`).expect(200);
      expect(receipt.body).toMatchObject({ amountKobo: '100000', externalReference: 'POS-1', borrowerName: 'Ngozi Eze' });
      expect(receipt.body.recordedByName).toMatch(/^Staff/);
    });

    it('builds a running statement that ends at the outstanding balance', async () => {
      const id = await activeLoan();
      await record(officer, id, pay('1300000', { paymentDate: '2026-11-01' })).expect(201);
      const { body: bad } = await record(officer, id, pay('999', { paymentDate: '2026-11-02' })).expect(201);
      await reverse(accountant, bad.id).expect(201);
      await record(officer, id, pay('1300000', { paymentDate: '2026-11-03' })).expect(201);

      const { body } = await auditor.get(`/loans/${id}/statement`).expect(200);
      expect(body.lines[0]).toMatchObject({ chargedKobo: '15600000', balanceKobo: '15600000' });
      expect(body.closingBalanceKobo).toBe((await loan(id)).outstanding.totalKobo);
      expect(body.closingBalanceKobo).toBe('13000000');
      expect(body.lines.some((line: { description: string }) => line.description.startsWith('Correction'))).toBe(true);
    });

    it('sorts a backdated payment by its date', async () => {
      const id = await activeLoan();
      await record(officer, id, pay('100000', { paymentDate: '2026-11-03' })).expect(201);
      await record(officer, id, pay('200000', { paymentDate: '2026-10-20' })).expect(201);
      const { body } = await auditor.get(`/loans/${id}/statement`).expect(200);
      expect(body.lines.slice(1).map((line: { date: string }) => line.date)).toEqual(['2026-10-20', '2026-11-03']);
      expect(body.closingBalanceKobo).toBe('15300000');
    });

    it('lists recent repayments for the lender', async () => {
      const id = await activeLoan();
      const { body } = await record(officer, id, pay('100000')).expect(201);
      const list = await auditor.get('/payments').expect(200);
      expect(list.body.map((row: { id: string }) => row.id)).toContain(body.id);
    });

    it('keeps it all from other lenders', async () => {
      const id = await activeLoan();
      const { body } = await record(officer, id, pay('100000')).expect(201);
      const other = await createTenant();
      const stranger = await signIn(app, other.slug, other.email);
      await stranger.get(`/payments/${body.id}`).expect(404);
      await stranger.get(`/loans/${id}/statement`).expect(404);
      await record(stranger, id, pay('100')).expect(404);
      await reverse(stranger, body.id).expect(404);
      expect((await stranger.get('/payments').expect(200)).body).toEqual([]);
    });
  });
});
