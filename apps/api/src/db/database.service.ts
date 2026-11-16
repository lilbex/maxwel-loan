import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config.js';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly pool: pg.Pool;
  private readonly db: Db;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 20 });
    this.db = drizzle(this.pool, { schema });
  }

  /** Row-level security silently does nothing for these roles, so refuse to run as one. */
  async onModuleInit(): Promise<void> {
    const { rows } = await this.pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
      'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    const role = rows[0];
    if (!role || role.rolsuper || role.rolbypassrls) {
      throw new Error(
        `Refusing to start: database role "${role?.rolname}" bypasses row-level security. Use the loan_app role.`,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }

  /**
   * The only way to reach tenant data. set_config(..., true) lasts for this transaction alone,
   * so a pooled connection cannot carry one lender's context into the next request.
   */
  withTenant<T>(tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return work(tx);
    });
  }

  async resolveTenantId(slug: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string | null }>('SELECT app.tenant_id_by_slug($1) AS id', [slug]);
    return rows[0]?.id ?? null;
  }

  async activeTenantIds(): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>('SELECT app.active_tenant_ids() AS id');
    return rows.map((row) => row.id);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
