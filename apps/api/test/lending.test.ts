import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appClient, asTenant, createApp, createTenant, PASSWORD, signIn } from './helpers.js';

type Agent = Awaited<ReturnType<typeof signIn>>;

const productBody = (overrides: object = {}) => ({
  name: `Weekly ${randomUUID().slice(0, 6)}`,
  interestMethod: 'flat',
  ratePercent: '5',
  ratePeriod: 'month',
  repaymentFrequency: 'weekly',
  periodBasis: 'simple',
  minPrincipalKobo: '1000000',
  maxPrincipalKobo: '50000000',
  minTerm: 4,
  maxTerm: 24,
  roundingUnitKobo: 100,
  fees: [{ name: 'Processing', type: 'percent_of_principal', percent: '2.5', timing: 'deducted_upfront' }],
  penalty: { type: 'none' },
  allocationOrder: ['penalty', 'fee', 'interest', 'principal'],
  ...overrides,
});
const uniquePhone = () => `080${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const disbursement = { disbursementDate: '2026-11-02', method: 'bank' as const };

describe('lending flow', () => {
  let app: NestExpressApplication;
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let admin: Agent;
  let officer: Agent;
  let approver: Agent;
  let secondApprover: Agent;
  let accountant: Agent;
  let auditor: Agent;
  let productId: string;

  const staff = async (roleNames: string[]) => {
    const email = `${randomUUID().slice(0, 8)}@x.test`;
    await admin.post('/users').send({ email, fullName: `Staff ${email.slice(0, 4)}`, password: PASSWORD, roleNames }).expect(201);
    return signIn(app, tenant.slug, email);
  };
  const newBorrower = async (agent: Agent = officer) =>
    (
      await agent
        .post('/borrowers')
        .send({ fullName: 'Ngozi Eze', phone: uniquePhone(), address: '12 Market Road, Aba', businessName: 'Ngozi Fabrics' })
        .expect(201)
    ).body;
  const application = (borrowerId: string, overrides: object = {}) => ({
    borrowerId,
    productId,
    principalKobo: '10000000',
    termCount: 12,
    purpose: 'Buy stock for the shop',
    guarantors: [{ fullName: 'Chidi Eze', phone: '08030000000', address: '4 Church St, Aba', relationship: 'Brother' }],
    collateral: [{ description: 'Sewing machine', estimatedValueKobo: '6000000' }],
    ...overrides,
  });
  const submitted = async (overrides: object = {}, agent: Agent = officer) => {
    const borrower = await newBorrower();
    const created = await agent.post('/loan-applications').send(application(borrower.id, overrides)).expect(201);
    await agent.post(`/loan-applications/${created.body.id}/submit`).expect(200);
    return created.body;
  };
  const approved = async (overrides: object = {}) => {
    const draft = await submitted(overrides);
    const { body } = await approver.post(`/loan-applications/${draft.id}/decision`).send({ decision: 'approved' }).expect(200);
    return body.loanId as string;
  };
  const balances = async () => {
    const { body } = await accountant.get('/ledger/trial-balance').expect(200);
    return Object.fromEntries(
      body.rows.map((row: { code: string; debitKobo: string; creditKobo: string }) => [
        row.code,
        BigInt(row.debitKobo) - BigInt(row.creditKobo),
      ]),
    ) as Record<string, bigint>;
  };

  beforeAll(async () => {
    app = await createApp();
    tenant = await createTenant();
    admin = await signIn(app, tenant.slug, tenant.email);
    [officer, approver, secondApprover, accountant, auditor] = await Promise.all([
      staff(['Loan Officer']),
      staff(['Approver']),
      staff(['Approver']),
      staff(['Accountant']),
      staff(['Auditor']),
    ]);
    productId = (await admin.post('/loan-products').send(productBody()).expect(201)).body.id;
  });
  afterAll(() => app.close());

  describe('borrowers', () => {
    it('numbers borrowers without gaps, even when added at the same time', async () => {
      const fresh = await createTenant();
      const owner = await signIn(app, fresh.slug, fresh.email);
      const created = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          owner.post('/borrowers').send({ fullName: `Person ${index}`, phone: uniquePhone(), address: 'Aba road' }),
        ),
      );
      const references = created.map((response) => response.body.reference).sort();
      expect(references).toEqual(Array.from({ length: 10 }, (_, index) => `B-${String(index + 1).padStart(5, '0')}`));
    });

    it('rejects a phone number already on file', async () => {
      const borrower = await newBorrower();
      await officer
        .post('/borrowers')
        .send({ fullName: 'Someone Else', phone: borrower.phone, address: 'Elsewhere' })
        .expect(409);
    });

    it('finds borrowers by name, phone or reference, and treats % literally', async () => {
      const borrower = await officer
        .post('/borrowers')
        .send({ fullName: 'Tunde Zebulon', phone: uniquePhone(), address: 'Ikeja' })
        .expect(201);
      for (const term of ['zebulon', borrower.body.phone, borrower.body.reference]) {
        const { body } = await officer.get(`/borrowers?search=${encodeURIComponent(term)}`).expect(200);
        expect(body.map((row: { id: string }) => row.id)).toContain(borrower.body.id);
      }
      const { body } = await officer.get('/borrowers?search=%25').expect(200);
      expect(body).toEqual([]);
    });

    it('clears optional details removed in an edit', async () => {
      const borrower = await newBorrower();
      const { body } = await officer
        .put(`/borrowers/${borrower.id}`)
        .send({ fullName: borrower.fullName, phone: borrower.phone, address: borrower.address })
        .expect(200);
      expect(body.businessName).toBeUndefined();
    });
  });

  describe('from application to disbursement', () => {
    it('runs end to end and posts the right ledger entry', async () => {
      const before = await balances();
      const borrower = await newBorrower();
      const created = await officer.post('/loan-applications').send(application(borrower.id)).expect(201);
      expect(created.body).toMatchObject({ status: 'draft', borrowerName: 'Ngozi Eze' });
      expect(created.body.guarantors).toHaveLength(1);
      expect(created.body.collateral[0].estimatedValueKobo).toBe('6000000');

      const url = `/loan-applications/${created.body.id}`;
      await officer.post(`${url}/submit`).expect(200);
      const decided = await approver.post(`${url}/decision`).send({ decision: 'approved' }).expect(200);
      expect(decided.body.status).toBe('approved');
      expect(decided.body.decisions).toHaveLength(1);

      const pending = await accountant.get(`/loans/${decided.body.loanId}`).expect(200);
      expect(pending.body).toMatchObject({ status: 'approved', installments: [] });

      const { body: loan } = await accountant
        .post(`/loans/${decided.body.loanId}/disburse`)
        .send({ ...disbursement, reference: 'TRF-1' })
        .expect(200);
      expect(loan.status).toBe('active');
      expect(loan.installments).toHaveLength(12);
      expect(loan.installments[0].dueDate).toBe('2026-11-09');
      expect(loan.disbursementReference).toBe('TRF-1');

      const after = await balances();
      expect(after['1100']! - before['1100']!).toBe(10_000_000n);
      expect(after['1010']! - before['1010']!).toBe(-9_750_000n);
      expect(after['4010']! - before['4010']!).toBe(-250_000n);

      const entry = await accountant.get(`/ledger/entries/${loan.disbursementEntryId}`).expect(200);
      expect(entry.body).toMatchObject({ sourceType: 'loan', sourceId: loan.id, effectiveDate: disbursement.disbursementDate });

      const report = await accountant.get('/ledger/trial-balance').expect(200);
      expect(report.body.balanced).toBe(true);
    });

    it('credits cash and skips fee income when a loan has no upfront fee', async () => {
      const free = await admin.post('/loan-products').send(productBody({ fees: [] })).expect(201);
      const before = await balances();
      const loanId = await approved({ productId: free.body.id });
      const { body } = await accountant.post(`/loans/${loanId}/disburse`).send({ ...disbursement, method: 'cash' }).expect(200);
      const entry = await accountant.get(`/ledger/entries/${body.disbursementEntryId}`).expect(200);
      expect(entry.body.lines).toHaveLength(2);
      const after = await balances();
      expect(after['1000']! - before['1000']!).toBe(-10_000_000n);
    });

    it('honours a chosen first due date and rejects future disbursement', async () => {
      const loanId = await approved();
      await accountant.post(`/loans/${loanId}/disburse`).send({ ...disbursement, disbursementDate: '2099-01-01' }).expect(422);
      await accountant.post(`/loans/${loanId}/disburse`).send({ ...disbursement, firstDueDate: '2026-10-01' }).expect(422);
      const { body } = await accountant.post(`/loans/${loanId}/disburse`).send({ ...disbursement, firstDueDate: '2026-11-20' }).expect(200);
      expect(body.installments[0].dueDate).toBe('2026-11-20');
    });
  });

  describe('maker-checker', () => {
    it('stops the person who prepared an application from deciding on it', async () => {
      const draft = await submitted({}, admin);
      for (const decision of [{ decision: 'approved' }, { decision: 'rejected', note: 'No reason' }]) {
        await admin.post(`/loan-applications/${draft.id}/decision`).send(decision).expect(403);
      }
    });

    it('stops whoever submitted an application from deciding on it', async () => {
      const borrower = await newBorrower();
      const created = await officer.post('/loan-applications').send(application(borrower.id)).expect(201);
      await admin.post(`/loan-applications/${created.body.id}/submit`).expect(200);
      await admin.post(`/loan-applications/${created.body.id}/decision`).send({ decision: 'approved' }).expect(403);
    });

    it('is enforced by the database as well', async () => {
      const loanId = await approved();
      const client = await appClient();
      await expect(
        asTenant(client, tenant.id, () =>
          client.query(
            `INSERT INTO loans (tenant_id, reference, application_id, borrower_id, principal_kobo, term_count, terms, prepared_by_user_id, approved_by_user_id)
             SELECT tenant_id, 'L-FAKE', application_id, borrower_id, principal_kobo, term_count, terms, approved_by_user_id, approved_by_user_id
             FROM loans WHERE id = $1`,
            [loanId],
          ),
        ),
      ).rejects.toThrow(/loans_maker_checker/);
      await client.end();
    });

    it('approves only once when two approvers act together', async () => {
      const draft = await submitted();
      const url = `/loan-applications/${draft.id}/decision`;
      const responses = await Promise.all([
        approver.post(url).send({ decision: 'approved' }),
        secondApprover.post(url).send({ decision: 'approved' }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    });
  });

  describe('application rules', () => {
    it('allows changes only while it is a draft', async () => {
      const draft = await submitted();
      const borrowerId = draft.borrowerId;
      await officer.put(`/loan-applications/${draft.id}`).send(application(borrowerId, { principalKobo: '2000000' })).expect(409);
    });

    it('sends a returned application back for changes, then lets it go through', async () => {
      const draft = await submitted();
      const url = `/loan-applications/${draft.id}`;
      await approver.post(`${url}/decision`).send({ decision: 'returned' }).expect(400);
      const returned = await approver.post(`${url}/decision`).send({ decision: 'returned', note: 'Add a second guarantor' }).expect(200);
      expect(returned.body.status).toBe('draft');
      const changed = await officer.put(url).send(application(draft.borrowerId, { principalKobo: '2000000' })).expect(200);
      expect(changed.body.principalKobo).toBe('2000000');
      await officer.post(`${url}/submit`).expect(200);
      const decided = await approver.post(`${url}/decision`).send({ decision: 'approved' }).expect(200);
      expect(decided.body.decisions.map((row: { decision: string }) => row.decision)).toEqual(['returned', 'approved']);
    });

    it('ends a rejected application without creating a loan', async () => {
      const draft = await submitted();
      const url = `/loan-applications/${draft.id}`;
      const { body } = await approver.post(`${url}/decision`).send({ decision: 'rejected', note: 'Too much existing debt' }).expect(200);
      expect(body).toMatchObject({ status: 'rejected', loanId: null });
      await approver.post(`${url}/decision`).send({ decision: 'approved' }).expect(409);
    });

    it('keeps applications within the product’s limits', async () => {
      const borrower = await newBorrower();
      await officer.post('/loan-applications').send(application(borrower.id, { principalKobo: '100' })).expect(422);
      await officer.post('/loan-applications').send(application(borrower.id, { termCount: 2 })).expect(422);
    });

    it('blocks new applications and approvals on an archived product', async () => {
      const product = await admin.post('/loan-products').send(productBody()).expect(201);
      const draft = await submitted({ productId: product.body.id });
      await admin.post(`/loan-products/${product.body.id}/status`).send({ status: 'archived' }).expect(200);
      await approver.post(`/loan-applications/${draft.id}/decision`).send({ decision: 'approved' }).expect(422);
      const stillSubmitted = await officer.get(`/loan-applications/${draft.id}`).expect(200);
      expect(stillSubmitted.body).toMatchObject({ status: 'submitted', decisions: [] });
    });
  });

  describe('loan terms', () => {
    it('freezes terms at approval, so later product changes do not reach the loan', async () => {
      const product = await admin.post('/loan-products').send(productBody()).expect(201);
      const loanId = await approved({ productId: product.body.id });
      await admin
        .put(`/loan-products/${product.body.id}`)
        .send(productBody({ name: product.body.name, ratePercent: '20', fees: [] }))
        .expect(200);
      const { body } = await accountant.post(`/loans/${loanId}/disburse`).send(disbursement).expect(200);
      expect(body.terms.ratePercent).toBe('5');
      const interest = body.installments.reduce((sum: bigint, row: { interestKobo: string }) => sum + BigInt(row.interestKobo), 0n);
      expect(interest).toBe(1_500_000n);
    });

    it('gives the API no way to change terms or the schedule in the database', async () => {
      const loanId = await approved();
      await accountant.post(`/loans/${loanId}/disburse`).send(disbursement).expect(200);
      const client = await appClient();
      for (const statement of [
        `UPDATE loans SET principal_kobo = 1 WHERE id = '${loanId}'`,
        `UPDATE loans SET terms = '{}' WHERE id = '${loanId}'`,
        `UPDATE loans SET approved_by_user_id = prepared_by_user_id WHERE id = '${loanId}'`,
        `DELETE FROM loans WHERE id = '${loanId}'`,
        `UPDATE schedule_items SET total_kobo = 1 WHERE loan_id = '${loanId}'`,
        `DELETE FROM schedule_items WHERE loan_id = '${loanId}'`,
        `UPDATE approvals SET decision = 'rejected'`,
        `DELETE FROM approvals`,
      ]) {
        await expect(asTenant(client, tenant.id, () => client.query(statement)), statement).rejects.toThrow(/permission denied/);
      }
      await client.end();
    });

    it('will not mark a loan active without a ledger entry', async () => {
      const loanId = await approved();
      const client = await appClient();
      await expect(
        asTenant(client, tenant.id, () => client.query(`UPDATE loans SET status = 'active' WHERE id = $1`, [loanId])),
      ).rejects.toThrow(/loans_active_is_disbursed/);
      await client.end();
    });
  });

  describe('disbursement safety', () => {
    it('pays once when the button is pressed five times together', async () => {
      const loanId = await approved();
      const before = await balances();
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => accountant.post(`/loans/${loanId}/disburse`).send(disbursement)),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409, 409, 409]);
      const after = await balances();
      expect(after['1100']! - before['1100']!).toBe(10_000_000n);
      const { body } = await accountant.get(`/loans/${loanId}`).expect(200);
      expect(body.installments).toHaveLength(12);
    });

    it('cancels an undisbursed loan and then refuses to pay it', async () => {
      const loanId = await approved();
      await approver.post(`/loans/${loanId}/cancel`).expect(200);
      await accountant.post(`/loans/${loanId}/disburse`).send(disbursement).expect(409);
      await approver.post(`/loans/${loanId}/cancel`).expect(409);
    });

    it('does not cancel a disbursed loan', async () => {
      const loanId = await approved();
      await accountant.post(`/loans/${loanId}/disburse`).send(disbursement).expect(200);
      await approver.post(`/loans/${loanId}/cancel`).expect(409);
    });
  });

  describe('permissions and isolation', () => {
    it('keeps each role to its job', async () => {
      const draft = await submitted();
      await officer.post(`/loan-applications/${draft.id}/decision`).send({ decision: 'approved' }).expect(403);
      await accountant.post(`/loan-applications/${draft.id}/decision`).send({ decision: 'approved' }).expect(403);
      await approver.post('/borrowers').send({ fullName: 'No', phone: uniquePhone(), address: 'No road' }).expect(403);
      const { body } = await approver.post(`/loan-applications/${draft.id}/decision`).send({ decision: 'approved' }).expect(200);
      await officer.post(`/loans/${body.loanId}/disburse`).send(disbursement).expect(403);
      await approver.post(`/loans/${body.loanId}/disburse`).send(disbursement).expect(403);
      await auditor.get(`/loans/${body.loanId}`).expect(200);
      await auditor.get('/borrowers').expect(200);
      await auditor.post(`/loans/${body.loanId}/disburse`).send(disbursement).expect(403);
    });

    it('lists staff with their roles', async () => {
      const { body } = await admin.get('/users').expect(200);
      expect(body.find((row: { email: string }) => row.email === tenant.email).roles).toEqual(['Admin']);
      const roles = await admin.get('/users/roles').expect(200);
      expect(roles.body).toEqual(['Accountant', 'Admin', 'Approver', 'Auditor', 'Loan Officer']);
    });

    it('hides everything from other lenders and rejects their ids', async () => {
      const loanId = await approved();
      const borrower = await newBorrower();
      const other = await createTenant();
      const stranger = await signIn(app, other.slug, other.email);
      await stranger.get(`/loans/${loanId}`).expect(404);
      await stranger.post(`/loans/${loanId}/disburse`).send(disbursement).expect(404);
      await stranger.get(`/borrowers/${borrower.id}`).expect(404);
      expect((await stranger.get('/loans').expect(200)).body).toEqual([]);
      expect((await stranger.get('/borrowers').expect(200)).body).toEqual([]);
      const theirProduct = await stranger.post('/loan-products').send(productBody()).expect(201);
      await stranger
        .post('/loan-applications')
        .send(application(borrower.id, { productId: theirProduct.body.id }))
        .expect(422);
    });
  });
});
