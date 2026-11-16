import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function runMigrations(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.MIGRATOR_DATABASE_URL;
  if (!url) throw new Error('MIGRATOR_DATABASE_URL is required');
  await runMigrations(url);
  console.log('Migrations applied');
}
