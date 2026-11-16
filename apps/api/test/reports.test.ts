import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { koboToDecimal, toCsv } from '@loan-platform/api-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CollectionsService } from '../src/modules/loans/collections.service.js';
import { createApp, createTenant, PASSWORD, signIn } from './helpers.js';

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
  fees: [{ name: 'Processing', type: 'percent_of_principal', percent: '2.5', timing: 'deducted_upfront' }],
  penalty: { type: 'none' },
  allocationOrder: ['penalty', 'fee', 'interest', 'principal'],
  ...overrides,
});

describe('reports', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp();
  });
  afterAll(() => app.close());

  const lender = async () => {
    const tenant = await createTenant();
    const admin = await signIn(app, tenant.slug, tenant.email);
    const staff = async (roleNames: string[]) => {
      const email = `${randomUUID().slice(0, 8)}@x.test`;
      await admin.post('/users').send({ email, fullName: `Staff ${email.slice(0, 4)}`, password: PASSWORD, roleNames }).expect(201);
      return signIn(app, tenant.slug, email);
    };
    const [officer, approver, accountant] = await Promise.all([
      staff(['Loan Officer']),
      staff(['Approver']),
      staff(['Accountant']),
    ]);
    const loan = async (date: string, productBody: object = product(), method = 'bank') => {
      const { body: created } = await admin.post('/loan-products').send(productBody).expect(201);
      const phone = `081${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
      const borrower = await officer.post('/borrowers').send({ fullName: 'Ada Nwosu', phone, address: 'Enugu' }).expect(201);
      const application = await officer
        .post('/loan-applications')
        .send({ borrowerId: borrower.body.id, productId: created.id, principalKobo: '12000000', termCount: 12, purpose: 'Stock', guarantors: [], collateral: [] })
        .expect(201);
      await officer.post(`/loan-applications/${application.body.id}/submit`).expect(200);
      const decided = await approver.post(`/loan-applications/${application.body.id}/decision`).send({ decision: 'approved' }).expect(200);
      await accountant.post(`/loans/${decided.body.loanId}/disburse`).send({ disbursementDate: date, method }).expect(200);
      return decided.body.loanId as string;
    };
    const pay = (agent: Agent, id: string, amountKobo: string, paymentDate: string, method = 'bank') =>
      agent.post(`/loans/${id}/payments`).set('Idempotency-Key', randomUUID()).send({ amountKobo, paymentDate, method }).expect(201);
    const capital = (amountKobo: string, effectiveDate: string) =>
      accountant
        .post('/ledger/entries')
        .set('Idempotency-Key', randomUUID())
        .send({
          effectiveDate,
          description: 'Owner capital',
          lines: [
            { accountCode: '1010', side: 'debit', amountKobo },
            { accountCode: '3000', side: 'credit', amountKobo },
          ],
        })
        .expect(201);
    return { tenant, admin, officer, approver, accountant, staff, loan, pay, capital };
  };

  const range = '?from=2026-01-01&to=2026-12-31';
  const lineOf = (lines: { code: string; amountKobo: string }[], code: string) =>
    lines.find((line) => line.code === code)?.amountKobo;

  it('reports cash collected by day, split by method and purpose', async () => {
    const { accountant, officer, loan, pay } = await lender();
    const id = await loan('2026-01-05');
    await pay(officer, id, '1300000', '2026-02-05');
    await pay(officer, id, '400000', '2026-02-05', 'cash');
    await pay(officer, id, '900000', '2026-03-05');

    const { body } = await accountant.get(`/reports/collected${range}`).expect(200);
    expect(body.days.map((day: { date: string }) => day.date)).toEqual(['2026-02-05', '2026-03-05']);
    expect(body.days[0]).toMatchObject({
      receipts: 2,
      cashKobo: '400000',
      bankKobo: '1300000',
      principalKobo: '1100000',
      interestKobo: '600000',
      totalKobo: '1700000',
    });
    expect(body.totals).toMatchObject({ receipts: 3, totalKobo: '2600000', principalKobo: '2000000', interestKobo: '600000' });
  });

  it('respects the date range at both ends', async () => {
    const { accountant, officer, loan, pay } = await lender();
    const id = await loan('2026-01-05');
    for (const date of ['2026-01-31', '2026-02-01', '2026-02-28', '2026-03-01']) await pay(officer, id, '100000', date);
    const { body } = await accountant.get('/reports/collected?from=2026-02-01&to=2026-02-28').expect(200);
    expect(body.totals).toMatchObject({ receipts: 2, totalKobo: '200000' });
  });

  it('shows a correction as a negative on its own date and ties to the ledger', async () => {
    const { accountant, officer, loan, pay } = await lender();
    const id = await loan('2026-01-05');
    const { body: payment } = await pay(officer, id, '1300000', '2026-02-05');
    await accountant.post(`/payments/${payment.id}/reverse`).set('Idempotency-Key', randomUUID()).send({ reason: 'Bounced transfer' }).expect(201);

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());
    const february = await accountant.get('/reports/collected?from=2026-02-01&to=2026-02-28').expect(200);
    expect(february.body.totals.interestKobo).toBe('300000');

    const later = await accountant.get(`/reports/collected?from=2026-03-01&to=${today}`).expect(200);
    expect(later.body.totals).toMatchObject({ corrections: 1, receipts: 0, totalKobo: '-1300000', interestKobo: '-300000' });

    const whole = await accountant.get(`/reports/collected?from=2026-01-01&to=${today}`).expect(200);
    expect(whole.body.totals.totalKobo).toBe('0');
    const financials = await accountant.get(`/reports/financials?from=2026-01-01&to=${today}`).expect(200);
    expect(lineOf(financials.body.income, '4000')).toBeUndefined();
  });

  it('lists disbursements with fees taken and cash paid out', async () => {
    const { accountant, loan } = await lender();
    await loan('2026-01-05');
    await loan('2026-01-06', product({ fees: [] }), 'cash');
    await loan('2025-12-31');
    const { body } = await accountant.get('/reports/disbursements?from=2026-01-01&to=2026-01-31').expect(200);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({ date: '2026-01-05', method: 'bank', feesDeductedKobo: '300000', paidOutKobo: '11700000' });
    expect(body).toMatchObject({ totalPrincipalKobo: '24000000', totalFeesDeductedKobo: '300000', totalPaidOutKobo: '23700000' });
  });

  it('keeps fees shown as frozen at approval when a product later changes', async () => {
    const { accountant, admin, loan } = await lender();
    const body = product();
    await loan('2026-01-05', body);
    const { body: products } = await admin.get('/loan-products').expect(200);
    await admin.put(`/loan-products/${products[0].id}`).send({ ...body, fees: [] }).expect(200);
    const report = await accountant.get('/reports/disbursements?from=2026-01-01&to=2026-01-31').expect(200);
    expect(report.body.rows[0].feesDeductedKobo).toBe('300000');
  });

  it('produces profit and loss and a balance sheet that balances', async () => {
    const { accountant, officer, loan, pay, capital } = await lender();
    await capital('50000000', '2026-01-01');
    const id = await loan('2026-01-05');
    await pay(officer, id, '1300000', '2026-02-05');
    await pay(officer, id, '1300000', '2026-03-05');

    const { body } = await accountant.get(`/reports/financials${range}`).expect(200);
    expect(body.totalIncomeKobo).toBe('900000');
    expect(lineOf(body.income, '4000')).toBe('600000');
    expect(lineOf(body.income, '4010')).toBe('300000');
    expect(body.profitKobo).toBe('900000');
    expect(body.balanced).toBe(true);
    expect(lineOf(body.assets, '1100')).toBe('10000000');
    expect(lineOf(body.assets, '1010')).toBe('40900000');
    expect(lineOf(body.equity, '3000')).toBe('50000000');
    expect(body.earningsToDateKobo).toBe('900000');
    expect(body.totalAssetsKobo).toBe('50900000');
    expect(body.totalLiabilitiesAndEquityKobo).toBe('50900000');
  });

  it('limits profit to the range but keeps earlier earnings on the balance sheet', async () => {
    const { accountant, officer, loan, pay, capital } = await lender();
    await capital('50000000', '2026-01-01');
    const id = await loan('2026-01-05');
    await pay(officer, id, '1300000', '2026-02-05');
    await pay(officer, id, '1300000', '2026-03-05');

    const { body } = await accountant.get('/reports/financials?from=2026-03-01&to=2026-03-31').expect(200);
    expect(body.profitKobo).toBe('300000');
    expect(body.earningsToDateKobo).toBe('900000');
    expect(body.balanced).toBe(true);

    const early = await accountant.get('/reports/financials?from=2026-01-01&to=2026-01-31').expect(200);
    expect(early.body.earningsToDateKobo).toBe('300000');
    expect(lineOf(early.body.assets, '1100')).toBe('12000000');
    expect(early.body.balanced).toBe(true);
  });

  it('deducts expenses and shows overpayments as a liability', async () => {
    const { accountant, officer, loan, pay, capital } = await lender();
    await capital('50000000', '2026-01-01');
    await accountant
      .post('/ledger/entries')
      .set('Idempotency-Key', randomUUID())
      .send({
        effectiveDate: '2026-02-01',
        description: 'Bad debt',
        lines: [
          { accountCode: '5000', side: 'debit', amountKobo: '100000' },
          { accountCode: '1190', side: 'credit', amountKobo: '100000' },
        ],
      })
      .expect(201);
    const id = await loan('2026-01-05', product({ fees: [] }));
    await pay(officer, id, '15700000', '2026-02-05');
    const { body } = await accountant.get(`/reports/financials${range}`).expect(200);
    expect(body.totalExpensesKobo).toBe('100000');
    expect(body.profitKobo).toBe('3500000');
    expect(lineOf(body.liabilities, '2000')).toBe('100000');
    expect(body.balanced).toBe(true);
  });

  it('summarises the portfolio, overall and by product', async () => {
    const { accountant, approver, officer, admin, loan } = await lender();
    const first = product({ name: 'Traders' });
    const lagos = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());
    const daysAgo = (days: number) => new Date(Date.parse(`${lagos}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
    await loan(daysAgo(75), first);
    await loan(daysAgo(2), product({ name: 'Artisans' }));

    const borrower = await officer.post('/borrowers').send({ fullName: 'Waiting', phone: '08099999999', address: 'Ibadan' }).expect(201);
    const { body: products } = await admin.get('/loan-products').expect(200);
    const application = await officer
      .post('/loan-applications')
      .send({ borrowerId: borrower.body.id, productId: products[0].id, principalKobo: '2000000', termCount: 6, purpose: 'Stock', guarantors: [], collateral: [] })
      .expect(201);
    await officer.post(`/loan-applications/${application.body.id}/submit`).expect(200);
    await approver.post(`/loan-applications/${application.body.id}/decision`).send({ decision: 'approved' }).expect(200);

    const { body } = await accountant.get('/reports/portfolio').expect(200);
    expect(body.loansByStatus).toEqual(expect.arrayContaining([
      { status: 'active', loans: 2 },
      { status: 'approved', loans: 1 },
    ]));
    expect(body).toMatchObject({ totalDisbursedKobo: '24000000', principalOutstandingKobo: '24000000', par30Percent: '50.00' });
    expect(body.products.map((row: { productName: string }) => row.productName)).toEqual(['Artisans', 'Traders']);
    expect(body.products[1]).toMatchObject({ activeLoans: 1, principalOverdueOver30Kobo: '12000000', par30Percent: '100.00' });
  });

  it('checks loan records against the ledger', async () => {
    const { accountant, officer, loan, pay } = await lender();
    const id = await loan('2026-01-05');
    await pay(officer, id, '1300000', '2026-02-05');
    const matched = await accountant.get('/reports/portfolio').expect(200);
    expect(matched.body.ledgerPrincipalKobo).toBe(matched.body.principalOutstandingKobo);
    expect(matched.body.ledgerPrincipalKobo).toBe('11000000');

    await accountant
      .post('/ledger/entries')
      .set('Idempotency-Key', randomUUID())
      .send({
        effectiveDate: '2026-02-06',
        description: 'Manual adjustment',
        lines: [
          { accountCode: '1100', side: 'debit', amountKobo: '5000' },
          { accountCode: '1010', side: 'credit', amountKobo: '5000' },
        ],
      })
      .expect(201);
    const { body } = await accountant.get('/reports/portfolio').expect(200);
    expect(body.ledgerPrincipalKobo).toBe('11005000');
    expect(body.principalOutstandingKobo).toBe('11000000');
  });

  it('agrees with penalties that are paid', async () => {
    const { tenant, accountant, officer, loan, pay } = await lender();
    const id = await loan('2026-01-05', product({
      fees: [],
      penalty: { type: 'flat', amountKobo: '50000', graceDays: 0, frequency: 'once' },
    }));
    await app.get(CollectionsService).applyForTenant(tenant.id, '2026-02-10');
    await pay(officer, id, '1350000', '2026-02-10');
    const collected = await accountant.get(`/reports/collected${range}`).expect(200);
    const financials = await accountant.get(`/reports/financials${range}`).expect(200);
    expect(collected.body.totals.penaltiesKobo).toBe('50000');
    expect(lineOf(financials.body.income, '4020')).toBe('50000');
  });

  it('reconciles collected figures with the ledger across random activity', async () => {
    const { accountant, officer, loan, pay, capital } = await lender();
    await capital('900000000', '2026-01-01');
    const ids = [await loan('2026-01-05'), await loan('2026-01-07', product({ fees: [] }), 'cash')];
    for (let index = 0; index < 25; index += 1) {
      const amount = String(1 + Math.floor(Math.random() * 2_000_000));
      const day = String(1 + Math.floor(Math.random() * 27)).padStart(2, '0');
      const { body } = await pay(officer, ids[index % 2]!, amount, `2026-0${2 + (index % 6)}-${day}`, index % 3 ? 'bank' : 'cash');
      if (index % 7 === 0) {
        await accountant.post(`/payments/${body.id}/reverse`).set('Idempotency-Key', randomUUID()).send({ reason: 'Random test' }).expect(201);
      }
    }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());
    const period = `?from=2026-01-01&to=${today}`;
    const { body: collected } = await accountant.get(`/reports/collected${period}`).expect(200);
    const { body: financials } = await accountant.get(`/reports/financials${period}`).expect(200);
    const { body: disbursed } = await accountant.get(`/reports/disbursements${period}`).expect(200);

    expect(financials.balanced).toBe(true);
    expect(lineOf(financials.income, '4000') ?? '0').toBe(collected.totals.interestKobo);
    expect(BigInt(lineOf(financials.assets, '1100') ?? 0)).toBe(
      BigInt(disbursed.totalPrincipalKobo) - BigInt(collected.totals.principalKobo),
    );
    expect(BigInt(lineOf(financials.assets, '1000') ?? 0) + BigInt(lineOf(financials.assets, '1010') ?? 0)).toBe(
      900_000_000n - BigInt(disbursed.totalPaidOutKobo) + BigInt(collected.totals.totalKobo),
    );
  });

  it('rejects bad ranges, limits access, and keeps lenders apart', async () => {
    const { admin, accountant, officer, loan, staff } = await lender();
    await loan('2026-01-05');
    await accountant.get('/reports/collected?from=2026-02-01&to=2026-01-01').expect(400);
    await accountant.get('/reports/collected?from=nope&to=2026-01-01').expect(400);
    await accountant.get('/reports/collected').expect(400);

    for (const path of ['/reports/portfolio', `/reports/collected${range}`, `/reports/financials${range}`, `/reports/disbursements${range}`]) {
      await officer.get(path).expect(403);
    }
    const auditor = await staff(['Auditor']);
    await auditor.get('/reports/portfolio').expect(200);
    await admin.get('/reports/portfolio').expect(200);

    const other = await createTenant();
    const stranger = await signIn(app, other.slug, other.email);
    const disbursed = await stranger.get(`/reports/disbursements${range}`).expect(200);
    expect(disbursed.body.rows).toEqual([]);
    const portfolio = await stranger.get('/reports/portfolio').expect(200);
    expect(portfolio.body.totalDisbursedKobo).toBe('0');
    const financials = await stranger.get(`/reports/financials${range}`).expect(200);
    expect(financials.body).toMatchObject({ totalAssetsKobo: '0', assets: [], balanced: true });
  });

  describe('CSV export', () => {
    it('quotes commas, quotes and line breaks', () => {
      expect(toCsv([['Eze, Ngozi', 'She said "hi"', 'a\nb']])).toBe('"Eze, Ngozi","She said ""hi""","a\nb"\r\n');
    });

    it('stops staff-typed text from running as a spreadsheet formula', () => {
      expect(toCsv([['=HYPERLINK("http://x")', '+1', '-cmd', '@sum']])).toBe(`"'=HYPERLINK(""http://x"")",'+1,'-cmd,'@sum\r\n`);
    });

    it('leaves amounts as numbers, including negatives', () => {
      expect(toCsv([['-1300.00', '12.50', 7]])).toBe('-1300.00,12.50,7\r\n');
    });

    it('formats kobo without passing through a float', () => {
      expect(koboToDecimal('900000000000000001')).toBe('9000000000000000.01');
      expect(koboToDecimal('-5')).toBe('-0.05');
      expect(koboToDecimal('0')).toBe('0.00');
    });
  });
});
