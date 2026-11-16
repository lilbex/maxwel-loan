import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres_dev@localhost:5432/postgres';
export const TEST_DB = 'loan_platform_test';

/** Builds a throwaway database from the real migrations, using the same two roles as production. */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const [role, password] of [
    ['loan_migrator', 'loan_migrator_dev'],
    ['loan_app', 'loan_app_dev'],
  ]) {
    const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (!exists.rowCount) {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    }
  }
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB} OWNER loan_migrator`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  const database = new pg.Client({ connectionString: url.toString() });
  await database.connect();
  await database.query('ALTER SCHEMA public OWNER TO loan_migrator');
  await database.end();

  url.username = 'loan_migrator';
  url.password = 'loan_migrator_dev';
  await runMigrations(url.toString());
}
