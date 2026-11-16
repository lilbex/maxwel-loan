import { parseArgs } from 'node:util';
import pg from 'pg';
import { provisionTenant } from '../modules/tenants/provision.js';

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    'admin-email': { type: 'string' },
    'admin-name': { type: 'string' },
  },
});
const password = process.env.ADMIN_PASSWORD;
const { slug, name, 'admin-email': adminEmail, 'admin-name': adminName } = values;

if (!slug || !name || !adminEmail || !adminName || !password) {
  console.error(
    'Usage: ADMIN_PASSWORD=... pnpm tenant:create --slug acme --name "Acme Finance" --admin-email a@acme.ng --admin-name "Ada Obi"',
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
await client.connect();
try {
  const tenantId = await provisionTenant(client, { slug, name, adminEmail, adminName, adminPassword: password });
  console.log(`Created workspace "${slug}" (${tenantId})`);
} finally {
  await client.end();
}
