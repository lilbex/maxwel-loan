import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(4000),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  COOKIE_SECURE: z.stringbool().default(true),
  TRUST_PROXY: z.string().default('loopback'),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JOBS_ENABLED: z.stringbool().default(true),
  /** Cron pattern, in Africa/Lagos time, for the daily penalty run. */
  PENALTY_SCHEDULE: z.string().default('30 0 * * *'),
});

export type AppConfig = z.infer<typeof schema>;
export const APP_CONFIG = Symbol('APP_CONFIG');
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => schema.parse(env);
