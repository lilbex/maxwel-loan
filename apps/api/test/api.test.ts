import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createTenant, entry, PASSWORD, signIn } from './helpers.js';

describe('HTTP API', () => {
  let app: NestExpressApplication;
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let other: Awaited<ReturnType<typeof createTenant>>;
  let admin: Awaited<ReturnType<typeof signIn>>;

  const http = () => request(app.getHttpServer());
  const post = (body: object, key: string = randomUUID()) =>
    admin.post('/ledger/entries').set('Idempotency-Key', key).send(body);

  beforeAll(async () => {
    app = await createApp();
    [tenant, other] = await Promise.all([createTenant(), createTenant()]);
    admin = await signIn(app, tenant.slug, tenant.email);
  });
  afterAll(() => app.close());

  describe('sign-in', () => {
    it('sets an HttpOnly, SameSite=Strict cookie and returns no secrets', async () => {
      const response = await http()
        .post('/auth/login')
        .send({ workspace: tenant.slug, email: tenant.email, password: PASSWORD })
        .expect(200);
      const cookie = String(response.headers['set-cookie']);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(JSON.stringify(response.body)).not.toMatch(/password/i);
      expect(response.body.permissions).toContain('ledger.post');
    });

    it('gives the same answer for a wrong password, unknown email and unknown workspace', async () => {
      const attempts = [
        { workspace: tenant.slug, email: tenant.email, password: 'wrong-password' },
        { workspace: tenant.slug, email: 'nobody@x.test', password: PASSWORD },
        { workspace: 'no-such-lender', email: tenant.email, password: PASSWORD },
      ];
      const messages = new Set<string>();
      for (const body of attempts) {
        const response = await http().post('/auth/login').send(body).expect(401);
        messages.add(response.body.message);
      }
      expect(messages.size).toBe(1);
    });

    it('locks the account after five failed attempts, even with the right password', async () => {
      const target = await createTenant();
      const bad = { workspace: target.slug, email: target.email, password: 'wrong-password' };
      for (let attempt = 0; attempt < 5; attempt += 1) await http().post('/auth/login').send(bad).expect(401);
      await http()
        .post('/auth/login')
        .send({ ...bad, password: PASSWORD })
        .expect(401);
    });

    it('rate-limits sign-in attempts', async () => {
      const limited = await createApp({ LOGIN_RATE_LIMIT_PER_MINUTE: '2' });
      const server = limited.getHttpServer();
      const body = { workspace: 'x', email: 'a@b.test', password: 'y' };
      await request(server).post('/auth/login').send(body).expect(401);
      await request(server).post('/auth/login').send(body).expect(401);
      await request(server).post('/auth/login').send(body).expect(429);
      await limited.close();
    });

    it('requires a session everywhere except sign-in and health', async () => {
      await http().get('/health').expect(200);
      for (const path of ['/auth/me', '/users', '/audit-events', '/ledger/accounts', '/ledger/trial-balance']) {
        await http().get(path).expect(401);
      }
    });

    it('revokes the session on sign-out', async () => {
      const agent = await signIn(app, tenant.slug, tenant.email);
      const login = await http()
        .post('/auth/login')
        .send({ workspace: tenant.slug, email: tenant.email, password: PASSWORD });
      const cookie = login.headers['set-cookie'] as unknown as string[];
      await http().get('/auth/me').set('Cookie', cookie).expect(200);
      await http().post('/auth/logout').set('Cookie', cookie).expect(204);
      await http().get('/auth/me').set('Cookie', cookie).expect(401);
      await agent.get('/auth/me').expect(200);
    });

    it('rejects a session whose tenant part was swapped for another lender', async () => {
      const login = await http()
        .post('/auth/login')
        .send({ workspace: tenant.slug, email: tenant.email, password: PASSWORD });
      const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
      const forged = cookie.replace(tenant.id, other.id);
      expect(forged).not.toBe(cookie);
      await http().get('/auth/me').set('Cookie', forged).expect(401);
    });
  });

  describe('permissions', () => {
    it('stops an Auditor from posting but lets them read', async () => {
      const email = `auditor-${randomUUID().slice(0, 6)}@x.test`;
      await admin
        .post('/users')
        .send({ email, fullName: 'Idris Auditor', password: PASSWORD, roleNames: ['Auditor'] })
        .expect(201);
      const auditor = await signIn(app, tenant.slug, email);
      await auditor.get('/ledger/trial-balance').expect(200);
      await auditor.get('/users').expect(200);
      await auditor.post('/ledger/entries').set('Idempotency-Key', randomUUID()).send(entry()).expect(403);
      await auditor
        .post('/users')
        .send({ email: 'x@x.test', fullName: 'No One', password: PASSWORD, roleNames: ['Admin'] })
        .expect(403);
    });

    it('rejects duplicate staff emails and unknown roles', async () => {
      const body = { email: tenant.email, fullName: 'Copy Cat', password: PASSWORD, roleNames: ['Auditor'] };
      await admin.post('/users').send(body).expect(409);
      await admin
        .post('/users')
        .send({ ...body, email: 'new@x.test', roleNames: ['Ghost'] })
        .expect(422);
    });
  });

  describe('ledger', () => {
    it('posts an entry and reads it back with exact amounts', async () => {
      const big = '900000000000000000'; // Far above what a JavaScript number can hold exactly.
      const { body } = await post(entry(big)).expect(201);
      const read = await admin.get(`/ledger/entries/${body.id}`).expect(200);
      expect(read.body.lines.map((line: { amountKobo: string }) => line.amountKobo)).toEqual([big, big]);
    });

    it('rejects an unbalanced entry before it reaches the database', async () => {
      const lines = [
        { accountCode: '1010', side: 'debit', amountKobo: '100' },
        { accountCode: '3000', side: 'credit', amountKobo: '99' },
      ];
      await post(entry('1', { lines })).expect(422);
    });

    it('rejects floats and unknown accounts', async () => {
      const float = entry('1', {
        lines: [
          { accountCode: '1010', side: 'debit', amountKobo: 10.5 },
          { accountCode: '3000', side: 'credit', amountKobo: 10.5 },
        ],
      });
      await post(float).expect(400);
      const unknown = entry('1', {
        lines: [
          { accountCode: '9999', side: 'debit', amountKobo: '100' },
          { accountCode: '3000', side: 'credit', amountKobo: '100' },
        ],
      });
      await post(unknown).expect(422);
    });

    it('requires an idempotency key', async () => {
      await admin.post('/ledger/entries').send(entry()).expect(400);
    });

    it('returns the original entry when a request is retried', async () => {
      const key = randomUUID();
      const first = await post(entry('12345'), key).expect(201);
      const second = await post(entry('12345'), key).expect(201);
      expect(second.body.id).toBe(first.body.id);
    });

    it('rejects reusing a key for different content', async () => {
      const key = randomUUID();
      await post(entry('100'), key).expect(201);
      await post(entry('200'), key).expect(409);
    });

    it('posts once when the same request arrives concurrently', async () => {
      const key = randomUUID();
      const responses = await Promise.all(Array.from({ length: 10 }, () => post(entry('777'), key)));
      expect(responses.map((response) => response.status)).toEqual(Array(10).fill(201));
      expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
    });

    it('reverses an entry, leaves the original, and nets the balances to zero', async () => {
      const fresh = await createTenant();
      const agent = await signIn(app, fresh.slug, fresh.email);
      const posted = await agent
        .post('/ledger/entries')
        .set('Idempotency-Key', randomUUID())
        .send(entry('5000'))
        .expect(201);
      const body = { effectiveDate: '2026-11-06', reason: 'Posted to the wrong account' };

      const key = randomUUID();
      const reversal = await agent
        .post(`/ledger/entries/${posted.body.id}/reversals`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      expect(reversal.body.reversesEntryId).toBe(posted.body.id);
      expect(reversal.body.lines[0].side).toBe('credit');

      // A retry returns the same reversal. A second reversal or a reversal of a reversal fails.
      const retry = await agent
        .post(`/ledger/entries/${posted.body.id}/reversals`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      expect(retry.body.id).toBe(reversal.body.id);
      await agent
        .post(`/ledger/entries/${posted.body.id}/reversals`)
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .expect(409);
      await agent
        .post(`/ledger/entries/${reversal.body.id}/reversals`)
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .expect(422);

      await agent.get(`/ledger/entries/${posted.body.id}`).expect(200);
      const before = await agent.get('/ledger/trial-balance?asOf=2026-11-05').expect(200);
      const after = await agent.get('/ledger/trial-balance?asOf=2026-11-06').expect(200);
      const bank = (report: { body: { rows: { code: string; balanceKobo: string }[] } }) =>
        report.body.rows.find((row) => row.code === '1010')!.balanceKobo;
      expect(bank(before)).toBe('5000');
      expect(bank(after)).toBe('0');
      expect(after.body.balanced).toBe(true);
    });

    it('keeps the trial balance balanced and exact across many random entries', async () => {
      const fresh = await createTenant();
      const agent = await signIn(app, fresh.slug, fresh.email);
      let expected = 0n;
      for (let index = 0; index < 40; index += 1) {
        const amount = BigInt(1 + Math.floor(Math.random() * 1e12));
        expected += amount;
        await agent
          .post('/ledger/entries')
          .set('Idempotency-Key', randomUUID())
          .send(entry(amount.toString(), { effectiveDate: '2026-01-01' }))
          .expect(201);
      }
      const { body } = await agent.get('/ledger/trial-balance').expect(200);
      expect(body.balanced).toBe(true);
      expect(body.totalDebitKobo).toBe(expected.toString());
    });

    it('never returns another lender’s entry', async () => {
      const { body } = await post(entry('42')).expect(201);
      const stranger = await signIn(app, other.slug, other.email);
      await stranger.get(`/ledger/entries/${body.id}`).expect(404);
      const report = await stranger.get('/ledger/trial-balance').expect(200);
      expect(report.body.totalDebitKobo).toBe('0');
    });

    it('records posting and sign-in in the audit log, rolled back with a failed posting', async () => {
      const fresh = await createTenant();
      const agent = await signIn(app, fresh.slug, fresh.email);
      await agent.post('/ledger/entries').set('Idempotency-Key', randomUUID()).send(entry('1')).expect(201);
      await agent
        .post('/ledger/entries')
        .set('Idempotency-Key', randomUUID())
        .send(entry('1', { lines: [entry().lines[0], entry().lines[0]] }))
        .expect(422);
      const { body } = await agent.get('/audit-events').expect(200);
      const actions = body.map((event: { action: string }) => event.action);
      expect(actions.filter((action: string) => action === 'ledger.entry_posted')).toHaveLength(1);
      expect(actions).toContain('auth.login');
      expect(actions).toContain('tenant.provisioned');
      expect(body[0].actorName).toBe('Ada Admin');
    });
  });
});
