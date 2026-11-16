import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createTenant, PASSWORD, signIn } from './helpers.js';

const product = (overrides: object = {}) => ({
  name: `Market women ${randomUUID().slice(0, 6)}`,
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
  penalty: { type: 'percent_of_overdue', percent: '1', graceDays: 3, frequency: 'daily' },
  allocationOrder: ['penalty', 'fee', 'interest', 'principal'],
  ...overrides,
});
const preview = { principalKobo: '10000000', termCount: 12, disbursementDate: '2026-11-05' };

describe('loan products API', () => {
  let app: NestExpressApplication;
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let admin: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    app = await createApp();
    tenant = await createTenant();
    admin = await signIn(app, tenant.slug, tenant.email);
  });
  afterAll(() => app.close());

  it('creates, reads and lists a product with its settings intact', async () => {
    const input = product({ ratePercent: '3.75' });
    const created = await admin.post('/loan-products').send(input).expect(201);
    expect(created.body).toMatchObject({ ...input, status: 'active' });
    const read = await admin.get(`/loan-products/${created.body.id}`).expect(200);
    expect(read.body).toMatchObject(input);
    const list = await admin.get('/loan-products').expect(200);
    expect(list.body.map((row: { id: string }) => row.id)).toContain(created.body.id);
  });

  it.each([
    ['a reversed amount range', { minPrincipalKobo: '5000', maxPrincipalKobo: '1000' }],
    ['a reversed term range', { minTerm: 10, maxTerm: 2 }],
    ['a repeated allocation bucket', { allocationOrder: ['fee', 'fee', 'interest', 'principal'] }],
    ['a missing allocation bucket', { allocationOrder: ['fee', 'interest', 'principal'] }],
    ['a float rate', { ratePercent: 5 }],
    ['a negative rate', { ratePercent: '-1' }],
    ['an unknown rounding unit', { roundingUnitKobo: 7 }],
  ])('rejects %s', async (_, overrides) => {
    await admin.post('/loan-products').send(product(overrides)).expect(400);
  });

  it('rejects a duplicate name', async () => {
    const input = product();
    await admin.post('/loan-products').send(input).expect(201);
    await admin.post('/loan-products').send(input).expect(409);
  });

  it('updates a product and records the previous settings', async () => {
    const created = await admin.post('/loan-products').send(product()).expect(201);
    const changed = product({ name: created.body.name, ratePercent: '6' });
    const updated = await admin.put(`/loan-products/${created.body.id}`).send(changed).expect(200);
    expect(updated.body.ratePercent).toBe('6');
    const audit = await admin.get('/audit-events?limit=5').expect(200);
    expect(audit.body.map((event: { action: string }) => event.action)).toContain('product.updated');
  });

  it('archives instead of deleting, and can reactivate', async () => {
    const created = await admin.post('/loan-products').send(product()).expect(201);
    const url = `/loan-products/${created.body.id}`;
    const archived = await admin.post(`${url}/status`).send({ status: 'archived' }).expect(200);
    expect(archived.body.status).toBe('archived');
    await admin.delete(url).expect(404);
    await admin.get(url).expect(200);
    await admin.post(`${url}/status`).send({ status: 'active' }).expect(200);
  });

  it('previews a schedule from the saved product', async () => {
    const created = await admin.post('/loan-products').send(product()).expect(201);
    const { body } = await admin.post(`/loan-products/${created.body.id}/schedule-preview`).send(preview).expect(200);
    expect(body.installments).toHaveLength(12);
    expect(body.totalInterestKobo).toBe('1500000');
    expect(body.netDisbursedKobo).toBe('9750000');
    expect(body.installments[0].dueDate).toBe('2026-11-12');
  });

  it('keeps previews within the product’s limits', async () => {
    const created = await admin.post('/loan-products').send(product()).expect(201);
    const url = `/loan-products/${created.body.id}/schedule-preview`;
    await admin.post(url).send({ ...preview, principalKobo: '100' }).expect(422);
    await admin.post(url).send({ ...preview, termCount: 2 }).expect(422);
    await admin.post(url).send({ ...preview, firstDueDate: '2026-11-01' }).expect(422);
  });

  it('lets an Auditor read and preview but not change products', async () => {
    const created = await admin.post('/loan-products').send(product()).expect(201);
    const email = `auditor-${randomUUID().slice(0, 6)}@x.test`;
    await admin
      .post('/users')
      .send({ email, fullName: 'Idris Auditor', password: PASSWORD, roleNames: ['Auditor'] })
      .expect(201);
    const auditor = await signIn(app, tenant.slug, email);
    await auditor.get('/loan-products').expect(200);
    await auditor.post(`/loan-products/${created.body.id}/schedule-preview`).send(preview).expect(200);
    await auditor.post('/loan-products').send(product()).expect(403);
    await auditor.put(`/loan-products/${created.body.id}`).send(product()).expect(403);
    await auditor.post(`/loan-products/${created.body.id}/status`).send({ status: 'archived' }).expect(403);
  });

  it('hides products from other lenders', async () => {
    const created = await admin.post('/loan-products').send(product()).expect(201);
    const other = await createTenant();
    const stranger = await signIn(app, other.slug, other.email);
    await stranger.get(`/loan-products/${created.body.id}`).expect(404);
    await stranger.put(`/loan-products/${created.body.id}`).send(product()).expect(404);
    await stranger.post(`/loan-products/${created.body.id}/schedule-preview`).send(preview).expect(404);
    const list = await stranger.get('/loan-products').expect(200);
    expect(list.body).toEqual([]);
  });
});
