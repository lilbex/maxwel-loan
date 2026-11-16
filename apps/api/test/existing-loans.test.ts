import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CollectionsService } from '../src/modules/loans/collections.service.js';
import { appClient, asTenant, createApp, createTenant, PASSWORD, signIn } from './helpers.js';

type Agent = Awaited<ReturnType<typeof signIn>>;

const product = (overrides: object = {}) => ({
  name: `Paper ${randomUUID().slice(0, 8)}`,
  interestMethod: 'flat',
  ratePercent: '2.5',
  ratePeriod: 'month',
  repaymentFrequency: 'monthly',
  periodBasis: 'simple',
  minPrincipalKobo: '5000000',
  maxPrincipalKobo: '20000000',
  minTerm: 6,
  maxTerm: 12,
  roundingUnitKobo: 1,
  fees: [{ name: 'Processing', type: 'percent_of_principal', percent: '2.5', timing: 'deducted_upfront' }],
  penalty: { type: 'none' },
  allocationOrder: ['penalty', 'fee', 'interest', 'principal'],
  ...overrides,
});
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());
const daysAgo = (days: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

describe('moving existing loans in', () => {
  let app: NestExpressApplication;
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let admin: Agent;
  let officer: Agent;
  let approver: Agent;
  let accountant: Agent;
  let auditor: Agent;
  let defaultProduct: string;

  const staff = async (roleNames: string[]) => {
    const email = `${randomUUID().slice(0, 8)}@x.test`;
    await admin.post('/users').send({ email, fullName: `Staff ${email.slice(0, 4)}`, password: PASSWORD, roleNames }).expect(201);
    return signIn(app, tenant.slug, email);
  };
  const newBorrower = async () =>
    (
      await officer
        .post('/borrowers')
        .send({ fullName: 'Ifeoma Okoro', phone: `0805${randomUUID().replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}`, address: 'Onitsha' })
        .expect(201)
    ).body.id as string;
  /** ₦120,000 over 12 months at 2.5% flat: ₦13,000 a month, ₦156,000 in all. */
  const draft = async (overrides: object = {}) => ({
    borrowerId: await newBorrower(),
    productId: defaultProduct,
    principalKobo: '12000000',
    termCount: 12,
    disbursementDate: daysAgo(100),
    paidKobo: '3900000',
    ...overrides,
  });
  const moveIn = async (overrides: object = {}) => {
    const created = await officer.post('/loan-applications/existing').send(await draft(overrides)).expect(201);
    await officer.post(`/loan-applications/${created.body.id}/submit`).expect(200);
    const decided = await approver.post(`/loan-applications/${created.body.id}/decision`).send({ decision: 'approved' }).expect(200);
    return decided.body.loanId as string;
  };
  const loan = async (id: string) => (await accountant.get(`/loans/${id}`).expect(200)).body;
  const ledger = async () => {
    const { body } = await accountant.get('/ledger/trial-balance').expect(200);
    expect(body.balanced).toBe(true);
    return Object.fromEntries(
      body.rows.map((row: { code: string; debitKobo: string; creditKobo: string }) => [
        row.code,
        BigInt(row.debitKobo) - BigInt(row.creditKobo),
      ]),
    ) as Record<string, bigint>;
  };

  beforeAll(async () => {
    app = await createApp();
    // draft() makes a request of its own, so the server must stay up between requests.
    await app.listen(0);
    tenant = await createTenant();
    admin = await signIn(app, tenant.slug, tenant.email);
    [officer, approver, accountant, auditor] = await Promise.all([
      staff(['Loan Officer']),
      staff(['Approver']),
      staff(['Accountant']),
      staff(['Auditor']),
    ]);
    defaultProduct = (await admin.post('/loan-products').send(product()).expect(201)).body.id;
  });
  afterAll(() => app.close());

  it('previews the balance before anything is saved', async () => {
    const { body } = await officer.post('/loan-applications/existing/preview').send(await draft()).expect(200);
    expect(body).toMatchObject({
      totalRepayableKobo: '15600000',
      paidKobo: '3900000',
      owedKobo: '11700000',
      principalOwedKobo: '9000000',
      interestOwedKobo: '2700000',
      installmentsCleared: 3,
    });
    expect((await officer.get('/loans').expect(200)).body).toEqual([]);
  });

  it('counts unpaid past repayments as overdue from the original dates', async () => {
    const { body } = await officer
      .post('/loan-applications/existing/preview')
      .send(await draft({ disbursementDate: daysAgo(100), paidKobo: '0' }))
      .expect(200);
    expect(BigInt(body.overdueKobo)).toBeGreaterThanOrEqual(3_900_000n);
    expect(body.installmentsCleared).toBe(0);
  });

  it('creates nothing until a second person confirms', async () => {
    const before = await ledger();
    const created = await officer.post('/loan-applications/existing').send(await draft()).expect(201);
    expect(created.body).toMatchObject({ kind: 'existing', status: 'draft', loanId: null });
    expect(created.body.existing.preview.owedKobo).toBe('11700000');
    await officer.post(`/loan-applications/${created.body.id}/submit`).expect(200);
    expect(await ledger()).toEqual(before);
  });

  it('stops the person who entered a loan from confirming it', async () => {
    const created = await admin.post('/loan-applications/existing').send(await draft()).expect(201);
    await admin.post(`/loan-applications/${created.body.id}/submit`).expect(200);
    await admin.post(`/loan-applications/${created.body.id}/decision`).send({ decision: 'approved' }).expect(403);
  });

  it('lets a checker return a wrong entry for fixing', async () => {
    const created = await officer.post('/loan-applications/existing').send(await draft()).expect(201);
    const url = `/loan-applications/${created.body.id}`;
    await officer.post(`${url}/submit`).expect(200);
    await approver.post(`${url}/decision`).send({ decision: 'returned', note: 'Paper says ₦30,000 paid' }).expect(200);
    const input = await draft({ borrowerId: created.body.borrowerId, paidKobo: '3000000' });
    const { body } = await officer.put(`/loan-applications/existing/${created.body.id}`).send(input).expect(200);
    expect(body.existing.paidKobo).toBe('3000000');
    await officer.put(`/loan-applications/existing/${created.body.id}`).send(input).expect(200);
    await officer.post(`${url}/submit`).expect(200);
    await officer.put(`/loan-applications/existing/${created.body.id}`).send(input).expect(409);
  });

  it('brings a confirmed loan in with the right balances and no cash or income', async () => {
    const before = await ledger();
    const id = await moveIn();
    const state = await loan(id);
    expect(state).toMatchObject({ status: 'active', origin: 'existing' });
    expect(state.installments).toHaveLength(12);
    expect(state.installments.slice(0, 3).every((row: { status: string }) => row.status === 'paid')).toBe(true);
    expect(state.outstanding).toMatchObject({ principalKobo: '9000000', interestKobo: '2700000', totalKobo: '11700000', paidKobo: '3900000' });

    const after = await ledger();
    expect(after['1100']! - before['1100']!).toBe(9_000_000n);
    expect(after['3200']! - before['3200']!).toBe(-9_000_000n);
    for (const code of ['1000', '1010', '4000', '4010', '4020']) expect(after[code], code).toBe(before[code]);
    expect(state.payments).toHaveLength(1);
    expect(state.payments[0]).toMatchObject({ isOpening: true, amountKobo: '3900000' });
  });

  it('handles a loan with nothing paid yet', async () => {
    const id = await moveIn({ paidKobo: '0' });
    const state = await loan(id);
    expect(state.outstanding.principalKobo).toBe('12000000');
    expect(state.payments).toEqual([]);
  });

  it('accepts terms outside the product limits, because the loan already exists', async () => {
    const id = await moveIn({ principalKobo: '100000000', termCount: 24, paidKobo: '0' });
    expect((await loan(id)).status).toBe('active');
  });

  it('does not charge upfront fees again or show them as income', async () => {
    const before = await ledger();
    await moveIn();
    expect((await ledger())['4010']).toBe(before['4010']);
  });

  it('honours a first repayment date from the paper record', async () => {
    const id = await moveIn({ disbursementDate: daysAgo(100), firstDueDate: daysAgo(90), paidKobo: '0' });
    expect((await loan(id)).installments[0].dueDate).toBe(daysAgo(90));
  });

  it('keeps later repayments normal, and income starts from here', async () => {
    const id = await moveIn();
    const before = await ledger();
    const { body } = await officer
      .post(`/loans/${id}/payments`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountKobo: '1300000', paymentDate: today(), method: 'bank' })
      .expect(201);
    expect(body.allocation).toMatchObject({ interestKobo: '300000', principalKobo: '1000000' });
    expect(body.balanceAfterKobo).toBe('10400000');
    const after = await ledger();
    expect(after['1010']! - before['1010']!).toBe(1_300_000n);
    expect(after['4000']! - before['4000']!).toBe(-300_000n);
    expect(after['1100']! - before['1100']!).toBe(-1_000_000n);
  });

  it('closes normally when the rest is paid', async () => {
    const id = await moveIn();
    await officer
      .post(`/loans/${id}/payments`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountKobo: '11700000', paymentDate: today(), method: 'bank' })
      .expect(201);
    const state = await loan(id);
    expect(state.status).toBe('closed');
    expect(state.outstanding.totalKobo).toBe('0');
  });

  it('charges no penalties for lateness before the move, only after', async () => {
    const { body: created } = await admin
      .post('/loan-products')
      .send(product({ penalty: { type: 'flat', amountKobo: '50000', graceDays: 0, frequency: 'daily' } }))
      .expect(201);
    const id = await moveIn({ productId: created.id, disbursementDate: daysAgo(200), paidKobo: '0' });
    const service = app.get(CollectionsService);

    await service.applyForTenant(tenant.id);
    expect((await loan(id)).outstanding.penaltyKobo).toBe('0');

    const tomorrow = new Date(Date.parse(`${today()}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await service.applyForTenant(tenant.id, tomorrow);
    const overdueItems = (await loan(id)).installments.filter((row: { status: string }) => row.status === 'overdue').length;
    expect((await loan(id)).outstanding.penaltyKobo).toBe(String(50_000 * overdueItems));
  });

  it('stays out of money collected and disbursements, which are this period only', async () => {
    const lender = await createTenant();
    const owner = await signIn(app, lender.slug, lender.email);
    const saved = { officer, approver, accountant, defaultProduct };
    const hire = async (roleNames: string[]) => {
      const email = `${randomUUID().slice(0, 8)}@x.test`;
      await owner.post('/users').send({ email, fullName: 'Hire', password: PASSWORD, roleNames }).expect(201);
      return signIn(app, lender.slug, email);
    };
    officer = await hire(['Loan Officer']);
    approver = await hire(['Approver']);
    accountant = await hire(['Accountant']);
    defaultProduct = (await owner.post('/loan-products').send(product()).expect(201)).body.id;

    const id = await moveIn();
    const period = `?from=2020-01-01&to=${today()}`;
    const collected = await accountant.get(`/reports/collected${period}`).expect(200);
    const disbursed = await accountant.get(`/reports/disbursements${period}`).expect(200);
    const portfolio = await accountant.get('/reports/portfolio').expect(200);
    const financials = await accountant.get(`/reports/financials${period}`).expect(200);
    expect(collected.body.days).toEqual([]);
    expect(disbursed.body.rows).toEqual([]);
    expect(portfolio.body.ledgerPrincipalKobo).toBe(portfolio.body.principalOutstandingKobo);
    expect(portfolio.body.principalOutstandingKobo).toBe('9000000');
    expect(financials.body.totalIncomeKobo).toBe('0');
    expect(financials.body.balanced).toBe(true);
    expect(financials.body.equity.find((line: { code: string }) => line.code === '3200').amountKobo).toBe('9000000');

    const statement = await accountant.get(`/loans/${id}/statement`).expect(200);
    expect(statement.body.lines.map((line: { description: string }) => line.description).join('|')).toContain(
      'Paid before moving to this system',
    );
    expect(statement.body.closingBalanceKobo).toBe('11700000');

    const summary = await accountant.get('/loans/opening-summary').expect(200);
    expect(summary.body).toMatchObject({
      loansMoved: 1,
      totalOwedKobo: '11700000',
      totalPrincipalKobo: '9000000',
      drafts: 0,
      waitingForCheck: 0,
    });
    expect(summary.body.rows[0]).toMatchObject({ paidBeforeKobo: '3900000', owedAtMoveKobo: '11700000', principalAtMoveKobo: '9000000' });

    officer = saved.officer;
    approver = saved.approver;
    accountant = saved.accountant;
    defaultProduct = saved.defaultProduct;
  });

  it('does not let the opening amount be corrected as a repayment', async () => {
    const id = await moveIn();
    const paymentId = (await loan(id)).payments[0].id;
    await accountant.post(`/payments/${paymentId}/reverse`).set('Idempotency-Key', randomUUID()).send({ reason: 'Trying' }).expect(422);
  });

  it('rejects fully repaid loans, future dates and inactive products', async () => {
    const url = '/loan-applications/existing';
    await officer.post(url).send(await draft({ paidKobo: '15600000' })).expect(422);
    await officer.post(url).send(await draft({ paidKobo: '99999999' })).expect(422);
    await officer.post(url).send(await draft({ disbursementDate: '2099-01-01' })).expect(422);
    const archived = await admin.post('/loan-products').send(product()).expect(201);
    await admin.post(`/loan-products/${archived.body.id}/status`).send({ status: 'archived' }).expect(200);
    await officer.post(url).send(await draft({ productId: archived.body.id })).expect(422);
  });

  it('rejects a loan with interest left but no principal', async () => {
    const principalFirst = await admin
      .post('/loan-products')
      .send(product({ allocationOrder: ['principal', 'interest', 'fee', 'penalty'], minTerm: 1 }))
      .expect(201);
    await officer
      .post('/loan-applications/existing')
      .send(await draft({ productId: principalFirst.body.id, termCount: 1, paidKobo: '12000000' }))
      .expect(422);
  });

  it('records opening cash and bank once, against Opening balances', async () => {
    const lender = await createTenant();
    const owner = await signIn(app, lender.slug, lender.email);
    const key = randomUUID();
    const first = await owner.post('/ledger/opening-cash').set('Idempotency-Key', key).send({ account: 'bank', amountKobo: '500000' }).expect(201);
    const retry = await owner.post('/ledger/opening-cash').set('Idempotency-Key', key).send({ account: 'bank', amountKobo: '500000' }).expect(201);
    expect(retry.body.id).toBe(first.body.id);
    await owner.post('/ledger/opening-cash').set('Idempotency-Key', randomUUID()).send({ account: 'cash', amountKobo: '100' }).expect(201);
    const { body } = await owner.get('/ledger/trial-balance').expect(200);
    const row = (code: string) => body.rows.find((item: { code: string }) => item.code === code);
    expect(row('1010').debitKobo).toBe('500000');
    expect(row('1000').debitKobo).toBe('100');
    expect(row('3200').creditKobo).toBe('500100');
    await officer.post('/ledger/opening-cash').set('Idempotency-Key', randomUUID()).send({ account: 'cash', amountKobo: '100' }).expect(403);
  });

  it('keeps roles and lenders to their own', async () => {
    await auditor.post('/loan-applications/existing').send(await draft()).expect(403);
    await auditor.post('/loan-applications/existing/preview').send(await draft()).expect(403);
    const input = await draft();
    const other = await createTenant();
    const stranger = await signIn(app, other.slug, other.email);
    await stranger.post('/loan-applications/existing').send(input).expect(422);
    const summary = await stranger.get('/loans/opening-summary').expect(200);
    expect(summary.body).toMatchObject({ loansMoved: 0, rows: [] });
  });

  it('adds Opening balances to lenders set up before this feature', async () => {
    const client = await appClient();
    const accounts = await asTenant(client, tenant.id, async () => (await client.query(`SELECT 1 FROM ledger_accounts WHERE code = '3200'`)).rowCount);
    expect(accounts).toBe(1);
    await client.end();
  });
});
