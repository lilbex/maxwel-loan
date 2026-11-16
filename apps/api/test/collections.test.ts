import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CollectionsService } from '../src/modules/loans/collections.service.js';
import { appClient, asTenant, createApp, createTenant, PASSWORD, signIn } from './helpers.js';

type Agent = Awaited<ReturnType<typeof signIn>>;

const product = (penalty: object) => ({
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
  penalty,
  allocationOrder: ['penalty', 'fee', 'interest', 'principal'],
});
const flatOnce = { type: 'flat', amountKobo: '50000', graceDays: 0, frequency: 'once' };
const onePercentDaily = { type: 'percent_of_overdue', percent: '1', graceDays: 0, frequency: 'daily' };

const lagosToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());
const daysAgo = (days: number) => new Date(Date.parse(`${lagosToday()}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

describe('penalties and collections', () => {
  let app: NestExpressApplication;
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let admin: Agent;
  let officer: Agent;
  let approver: Agent;
  let accountant: Agent;
  let auditor: Agent;
  let service: CollectionsService;

  const staffFor = async (owner: Agent, slug: string, roleNames: string[]) => {
    const email = `${randomUUID().slice(0, 8)}@x.test`;
    await owner.post('/users').send({ email, fullName: `Staff ${email.slice(0, 4)}`, password: PASSWORD, roleNames }).expect(201);
    return signIn(app, slug, email);
  };

  /** ₦120,000 over 12 months: ₦13,000 a month. The first repayment falls due a month after payout. */
  const loanFrom = async (penalty: object, paidOut: string, overrides: object = {}, termCount = 12) => {
    const { body: created } = await admin.post('/loan-products').send({ ...product(penalty), ...overrides }).expect(201);
    const phone = `070${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const borrower = await officer.post('/borrowers').send({ fullName: 'Bola Ade', phone, address: 'Ikeja' }).expect(201);
    const application = await officer
      .post('/loan-applications')
      .send({
        borrowerId: borrower.body.id,
        productId: created.id,
        principalKobo: '12000000',
        termCount,
        purpose: 'Stock',
        guarantors: [],
        collateral: [],
      })
      .expect(201);
    await officer.post(`/loan-applications/${application.body.id}/submit`).expect(200);
    const decided = await approver.post(`/loan-applications/${application.body.id}/decision`).send({ decision: 'approved' }).expect(200);
    await accountant
      .post(`/loans/${decided.body.loanId}/disburse`)
      .send({ disbursementDate: paidOut, method: 'bank' })
      .expect(200);
    return decided.body.loanId as string;
  };
  const record = (agent: Agent, id: string, amountKobo: string, paymentDate = lagosToday()) =>
    agent.post(`/loans/${id}/payments`).set('Idempotency-Key', randomUUID()).send({ amountKobo, paymentDate, method: 'bank' });
  const loan = async (id: string) => (await accountant.get(`/loans/${id}`).expect(200)).body;
  const incomeFromPenalties = async () => {
    const { body } = await accountant.get('/ledger/trial-balance').expect(200);
    const row = body.rows.find((item: { code: string }) => item.code === '4020');
    return BigInt(row.creditKobo) - BigInt(row.debitKobo);
  };

  beforeAll(async () => {
    app = await createApp();
    service = app.get(CollectionsService);
    tenant = await createTenant();
    admin = await signIn(app, tenant.slug, tenant.email);
    [officer, approver, accountant, auditor] = await Promise.all([
      staffFor(admin, tenant.slug, ['Loan Officer']),
      staffFor(admin, tenant.slug, ['Approver']),
      staffFor(admin, tenant.slug, ['Accountant']),
      staffFor(admin, tenant.slug, ['Auditor']),
    ]);
  });
  afterAll(() => app.close());

  describe('applying penalties', () => {
    it('adds charges for overdue installments and raises what is owed', async () => {
      const id = await loanFrom(flatOnce, daysAgo(40));
      await accountant.post('/collections/apply-penalties').expect(200);
      const state = await loan(id);
      expect(state.outstanding.penaltyKobo).toBe('50000');
      expect(state.outstanding.totalKobo).toBe('15650000');
      expect(state.installments[0].penaltyOwedKobo).toBe('50000');
    });

    it('is safe to run repeatedly, including at the same moment', async () => {
      const id = await loanFrom(onePercentDaily, daysAgo(35));
      await Promise.all(Array.from({ length: 5 }, () => service.applyForTenant(tenant.id)));
      const first = (await loan(id)).outstanding.penaltyKobo;
      const again = await service.applyForTenant(tenant.id);
      expect(again.chargesAdded).toBe(0);
      expect((await loan(id)).outstanding.penaltyKobo).toBe(first);
      expect(first).not.toBe('0');
    });

    it('catches up on missed days with the right amounts', async () => {
      const id = await loanFrom(onePercentDaily, daysAgo(40));
      const dueDate = (await loan(id)).installments[0].dueDate as string;
      const addDays = (days: number) => new Date(Date.parse(`${dueDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
      await service.applyForTenant(tenant.id, addDays(3));
      expect((await loan(id)).outstanding.penaltyKobo).toBe('39000');
      await service.applyForTenant(tenant.id, addDays(5));
      expect((await loan(id)).outstanding.penaltyKobo).toBe('65000');
    });

    it('does not touch the ledger until a penalty is paid', async () => {
      const id = await loanFrom(flatOnce, daysAgo(40));
      await service.applyForTenant(tenant.id);
      const before = await incomeFromPenalties();
      const { body } = await record(officer, id, '60000').expect(201);
      expect(body.allocation).toMatchObject({ penaltyKobo: '50000', interestKobo: '10000' });
      expect((await incomeFromPenalties()) - before).toBe(50_000n);
      expect((await loan(id)).outstanding.penaltyKobo).toBe('0');
    });

    it('needs penalties cleared before a loan closes', async () => {
      const id = await loanFrom(flatOnce, daysAgo(40));
      await service.applyForTenant(tenant.id);
      await record(officer, id, '15600000').expect(201);
      const state = await loan(id);
      expect(state.status).toBe('active');
      expect(state.outstanding.totalKobo).toBe('50000');
      await record(officer, id, '50000').expect(201);
      expect((await loan(id)).status).toBe('closed');
    });

    it('restores a paid penalty when the payment is corrected', async () => {
      const id = await loanFrom(flatOnce, daysAgo(40));
      await service.applyForTenant(tenant.id);
      const before = await incomeFromPenalties();
      const { body } = await record(officer, id, '60000').expect(201);
      await accountant.post(`/payments/${body.id}/reverse`).set('Idempotency-Key', randomUUID()).send({ reason: 'Wrong loan' }).expect(201);
      expect((await loan(id)).outstanding.penaltyKobo).toBe('50000');
      expect(await incomeFromPenalties()).toBe(before);
    });

    it('fills in charges skipped while a payment stood, once that payment is corrected', async () => {
      const id = await loanFrom(onePercentDaily, daysAgo(35));
      const dueDate = (await loan(id)).installments[0].dueDate as string;
      const { body } = await record(officer, id, '1300000', dueDate).expect(201);
      await service.applyForTenant(tenant.id);
      expect((await loan(id)).outstanding.penaltyKobo).toBe('0');
      await accountant.post(`/payments/${body.id}/reverse`).set('Idempotency-Key', randomUUID()).send({ reason: 'Bounced' }).expect(201);
      await service.applyForTenant(tenant.id);
      expect((await loan(id)).outstanding.penaltyKobo).not.toBe('0');
    });

    it('leaves loans on no-penalty products and other lenders alone', async () => {
      const id = await loanFrom({ type: 'none' }, daysAgo(40));
      const other = await createTenant();
      await service.applyForTenant(other.id);
      await service.applyForTenant(tenant.id);
      expect((await loan(id)).outstanding.penaltyKobo).toBe('0');
    });

    it('reaches every active lender from the daily run', async () => {
      const id = await loanFrom(flatOnce, daysAgo(40));
      await service.applyForAllTenants();
      expect((await loan(id)).outstanding.penaltyKobo).toBe('50000');
    });

    it('rejects a second charge for the same day at the database', async () => {
      const id = await loanFrom(flatOnce, daysAgo(40));
      await service.applyForTenant(tenant.id);
      const client = await appClient();
      await expect(
        asTenant(client, tenant.id, () =>
          client.query(
            `INSERT INTO penalty_charges (tenant_id, loan_id, schedule_item_id, charge_date, amount_kobo, basis_kobo)
             SELECT tenant_id, loan_id, schedule_item_id, charge_date, 1, 1 FROM penalty_charges WHERE loan_id = $1`,
            [id],
          ),
        ),
      ).rejects.toThrow(/penalty_charges_once_a_day/);
      for (const statement of [
        `UPDATE penalty_charges SET amount_kobo = 1`,
        `DELETE FROM penalty_charges`,
        `UPDATE penalty_waivers SET amount_kobo = 1`,
        `DELETE FROM penalty_waivers`,
        `DELETE FROM collection_notes`,
      ]) {
        await expect(asTenant(client, tenant.id, () => client.query(statement)), statement).rejects.toThrow(/permission denied/);
      }
      await client.end();
    });
  });

  describe('waivers', () => {
    const waive = (agent: Agent, id: string, amountKobo: string) =>
      agent.post(`/loans/${id}/penalty-waivers`).send({ amountKobo, reason: 'Hospital stay' });

    it('reduces what is owed with no ledger entry', async () => {
      const id = await loanFrom(flatOnce, daysAgo(40));
      await service.applyForTenant(tenant.id);
      const before = await incomeFromPenalties();
      const { body } = await waive(accountant, id, '20000').expect(201);
      expect(body.outstanding.penaltyKobo).toBe('30000');
      expect(await incomeFromPenalties()).toBe(before);
    });

    it('does not bring a waived charge back on the next run', async () => {
      const id = await loanFrom(flatOnce, daysAgo(40));
      await service.applyForTenant(tenant.id);
      await waive(accountant, id, '50000').expect(201);
      await service.applyForTenant(tenant.id);
      expect((await loan(id)).outstanding.penaltyKobo).toBe('0');
    });

    it('refuses to waive more than is owed, and needs permission', async () => {
      const id = await loanFrom(flatOnce, daysAgo(40));
      await service.applyForTenant(tenant.id);
      await waive(accountant, id, '50001').expect(422);
      await waive(officer, id, '100').expect(403);
      await waive(auditor, id, '100').expect(403);
    });

    it('closes a loan whose only balance was waived', async () => {
      const id = await loanFrom(flatOnce, daysAgo(40), { allocationOrder: ['principal', 'interest', 'fee', 'penalty'] }, 1);
      await service.applyForTenant(tenant.id);
      await record(officer, id, '12300000').expect(201);
      expect((await loan(id)).outstanding.totalKobo).toBe('50000');
      await waive(accountant, id, '50000').expect(201);
      expect((await loan(id)).status).toBe('closed');
    });
  });

  describe('statement', () => {
    it('shows charges and waivers, and ends at what is owed', async () => {
      const id = await loanFrom(flatOnce, daysAgo(40));
      await service.applyForTenant(tenant.id);
      await accountant.post(`/loans/${id}/penalty-waivers`).send({ amountKobo: '10000', reason: 'Goodwill' }).expect(201);
      await record(officer, id, '100000').expect(201);
      const { body } = await auditor.get(`/loans/${id}/statement`).expect(200);
      const text = body.lines.map((line: { description: string }) => line.description).join('|');
      expect(text).toContain('Late penalty');
      expect(text).toContain('Penalty waived: Goodwill');
      expect(body.closingBalanceKobo).toBe((await loan(id)).outstanding.totalKobo);
    });
  });

  describe('collections report', () => {
    it('sorts out due today, overdue, ageing and portfolio at risk', async () => {
      const lender = await createTenant();
      const owner = await signIn(app, lender.slug, lender.email);
      const [lenderOfficer, lenderApprover, lenderAccountant] = await Promise.all([
        staffFor(owner, lender.slug, ['Loan Officer']),
        staffFor(owner, lender.slug, ['Approver']),
        staffFor(owner, lender.slug, ['Accountant']),
      ]);
      const saved = { admin, officer, approver, accountant };
      admin = owner;
      officer = lenderOfficer;
      approver = lenderApprover;
      accountant = lenderAccountant;

      const today = lagosToday();
      const monthBack = (months: number) => {
        const date = new Date(`${today}T00:00:00Z`);
        date.setUTCMonth(date.getUTCMonth() - months);
        return date.toISOString().slice(0, 10);
      };
      const current = await loanFrom({ type: 'none' }, daysAgo(2));
      const late = await loanFrom({ type: 'none' }, daysAgo(75));
      const dueToday = await officerDueToday();

      async function officerDueToday() {
        const { body: created } = await admin.post('/loan-products').send(product({ type: 'none' })).expect(201);
        const borrower = await officer
          .post('/borrowers')
          .send({ fullName: 'Due Today', phone: `090${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, address: 'Ikeja' })
          .expect(201);
        const application = await officer
          .post('/loan-applications')
          .send({ borrowerId: borrower.body.id, productId: created.id, principalKobo: '12000000', termCount: 12, purpose: 'Stock', guarantors: [], collateral: [] })
          .expect(201);
        await officer.post(`/loan-applications/${application.body.id}/submit`).expect(200);
        const decided = await approver.post(`/loan-applications/${application.body.id}/decision`).send({ decision: 'approved' }).expect(200);
        await accountant
          .post(`/loans/${decided.body.loanId}/disburse`)
          .send({ disbursementDate: monthBack(3), firstDueDate: today, method: 'bank' })
          .expect(200);
        return decided.body.loanId as string;
      }

      const { body } = await lenderOfficer.get('/collections').expect(200);
      admin = saved.admin;
      officer = saved.officer;
      approver = saved.approver;
      accountant = saved.accountant;

      expect(body.activeLoans).toBe(3);
      expect(body.dueTodayKobo).toBe('1300000');
      const lateRow = body.rows.find((row: { loanId: string }) => row.loanId === late);
      const lateDays = lateRow.daysOverdue;
      expect(lateDays).toBeGreaterThanOrEqual(43);
      expect(lateDays).toBeLessThanOrEqual(46);
      expect(lateRow.overdueKobo).toBe('2600000');
      expect(body.overdueKobo).toBe(body.rows.reduce((sum: bigint, row: { overdueKobo: string }) => sum + BigInt(row.overdueKobo), 0n).toString());
      expect(body.rows[0].loanId).toBe(late);
      expect(body.rows.find((row: { loanId: string }) => row.loanId === dueToday).dueTodayKobo).toBe('1300000');
      expect(body.rows.find((row: { loanId: string }) => row.loanId === current)).toMatchObject({ daysOverdue: 0, overdueKobo: '0' });
      expect(body.ageing.find((bucket: { label: string }) => bucket.label === '31 to 60 days')).toMatchObject({ loans: 1, principalKobo: '12000000' });
      expect(body.principalAtRiskKobo).toBe('12000000');
      expect(body.par30Percent).toBe('33.33');
    });

    it('records notes and shows the latest promise', async () => {
      const id = await loanFrom({ type: 'none' }, daysAgo(40));
      await officer.post(`/loans/${id}/collection-notes`).send({ outcome: 'called', note: 'No reply' }).expect(201);
      await officer.post(`/loans/${id}/collection-notes`).send({ outcome: 'promised', note: 'Will pay Friday' }).expect(400);
      const { body } = await officer
        .post(`/loans/${id}/collection-notes`)
        .send({ outcome: 'promised', note: 'Will pay Friday', promisedDate: '2026-12-01', promisedAmountKobo: '500000' })
        .expect(201);
      expect(body).toMatchObject({ promisedAmountKobo: '500000', recordedByName: expect.stringMatching(/^Staff/) });
      expect((await loan(id)).notes).toHaveLength(2);
      const report = await officer.get('/collections').expect(200);
      expect(report.body.rows.find((row: { loanId: string }) => row.loanId === id)).toMatchObject({
        lastNote: 'Will pay Friday',
        promisedDate: '2026-12-01',
      });
    });

    it('keeps each role and lender to its own', async () => {
      const id = await loanFrom(flatOnce, daysAgo(40));
      await auditor.get('/collections').expect(200);
      await auditor.post('/collections/apply-penalties').expect(403);
      await officer.post('/collections/apply-penalties').expect(403);
      await auditor.post(`/loans/${id}/collection-notes`).send({ outcome: 'called', note: 'Tried to' }).expect(403);

      const other = await createTenant();
      const stranger = await signIn(app, other.slug, other.email);
      const report = await stranger.get('/collections').expect(200);
      expect(report.body).toMatchObject({ activeLoans: 0, rows: [], par30Percent: '0.00' });
      await stranger.post(`/loans/${id}/collection-notes`).send({ outcome: 'called', note: 'Sneaky' }).expect(404);
      await stranger.post(`/loans/${id}/penalty-waivers`).send({ amountKobo: '100', reason: 'Sneaky' }).expect(404);
    });
  });
});
