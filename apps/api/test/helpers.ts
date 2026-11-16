import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { provisionTenant } from '../src/modules/tenants/provision.js';

const host = new URL(process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://localhost:5432').host;
export const APP_URL = `postgres://loan_app:loan_app_dev@${host}/loan_platform_test`;
export const MIGRATOR_URL = `postgres://loan_migrator:loan_migrator_dev@${host}/loan_platform_test`;
export const PASSWORD = 'correct-horse-battery';

export async function createApp(overrides: Record<string, string> = {}): Promise<NestExpressApplication> {
  const config = loadConfig({
    DATABASE_URL: APP_URL,
    COOKIE_SECURE: 'false',
    LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
    JOBS_ENABLED: 'false',
    ...overrides,
  });
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { logger: false });
  configureApp(app, config);
  await app.init();
  return app;
}

export async function createTenant(): Promise<{ id: string; slug: string; email: string }> {
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const email = `admin@${slug}.test`;
  const client = new pg.Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  const id = await provisionTenant(client, {
    slug,
    name: `Lender ${slug}`,
    adminEmail: email,
    adminName: 'Ada Admin',
    adminPassword: PASSWORD,
  });
  await client.end();
  return { id, slug, email };
}

/** A connection as the API's role, for trying to break the rules without the service layer. */
export async function appClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: APP_URL });
  await client.connect();
  return client;
}

export async function asTenant<T>(client: pg.Client, tenantId: string, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function signIn(app: NestExpressApplication, slug: string, email: string, password = PASSWORD) {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/auth/login').send({ workspace: slug, email, password }).expect(200);
  return agent;
}

export const entry = (amountKobo = '5000000', overrides: object = {}) => ({
  effectiveDate: '2026-11-05',
  description: 'Owner funds the loan book',
  lines: [
    { accountCode: '1010', side: 'debit', amountKobo },
    { accountCode: '3000', side: 'credit', amountKobo },
  ],
  ...overrides,
});
