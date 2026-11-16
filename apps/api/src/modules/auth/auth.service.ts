import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { LoginRequest, Me } from '@loan-platform/api-client';
import type { AuthContext } from '../../common/request-context.js';
import { APP_CONFIG, type AppConfig } from '../../config.js';
import { DatabaseService, type Tx } from '../../db/database.service.js';
import { rolePermissions, sessions, tenants, userRoles, users } from '../../db/schema.js';
import { AuditService } from '../audit/audit.service.js';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const INVALID_LOGIN = 'Workspace, email or password is incorrect';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

interface ClientMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

@Injectable()
export class AuthService {
  /** Verified against when the account is unknown, so response time does not reveal which emails exist. */
  private readonly dummyHash = hash(randomBytes(32).toString('hex'));

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(input: LoginRequest, meta: ClientMeta): Promise<{ token: string; expiresAt: Date; me: Me }> {
    const tenantId = await this.database.resolveTenantId(input.workspace);
    if (!tenantId) {
      await verify(await this.dummyHash, input.password);
      throw new UnauthorizedException(INVALID_LOGIN);
    }

    const user = await this.database.withTenant(tenantId, async (tx) => {
      const [row] = await tx.select().from(users).where(eq(users.email, input.email));
      return row;
    });

    // Hashing is slow, so it runs outside any transaction to avoid holding a pooled connection.
    const passwordOk = await verify(user?.passwordHash ?? (await this.dummyHash), input.password);
    const locked = (user?.lockedUntil?.getTime() ?? 0) > Date.now();

    if (!user || !passwordOk || locked || user.status !== 'active') {
      await this.database.withTenant(tenantId, async (tx) => {
        if (user && !passwordOk && !locked) await this.recordFailure(tx, user.id);
        // The attempt names a user but may not be that user, so it is recorded with no actor.
        await this.audit.record(tx, { tenantId, userId: null, ...meta }, {
          action: 'auth.login_failed',
          entityType: 'user',
          entityId: user?.id,
          metadata: { email: input.email, reason: locked ? 'locked' : user ? 'credentials' : 'unknown_email' },
        });
      });
      throw new UnauthorizedException(INVALID_LOGIN);
    }

    const secret = randomBytes(32).toString('base64url');
    const token = `${tenantId}.${secret}`;
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL_HOURS * 3_600_000);

    return this.database.withTenant(tenantId, async (tx) => {
      await tx
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(users.id, user.id));
      await tx.insert(sessions).values({ tenantId, userId: user.id, tokenHash: hashToken(token), expiresAt });
      await this.audit.record(tx, { tenantId, userId: user.id, ...meta }, {
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
      });
      return { token, expiresAt, me: await this.loadMe(tx, tenantId, user.id) };
    });
  }

  private async recordFailure(tx: Tx, userId: string): Promise<void> {
    await tx
      .update(users)
      .set({
        failedLoginCount: sql`${users.failedLoginCount} + 1`,
        lockedUntil: sql`CASE WHEN ${users.failedLoginCount} + 1 >= ${MAX_FAILED_LOGINS}
          THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE ${users.lockedUntil} END`,
      })
      .where(eq(users.id, userId));
  }

  /** Every lookup is per request, so disabling a user or tenant, or changing a role, applies immediately. */
  async authenticate(token: string | undefined, meta: ClientMeta): Promise<AuthContext | null> {
    const tenantId = token?.split('.')[0];
    if (!token || !tenantId || !UUID.test(tenantId)) return null;

    return this.database.withTenant(tenantId, async (tx) => {
      const [session] = await tx
        .select({ id: sessions.id, userId: sessions.userId })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .innerJoin(tenants, eq(tenants.id, sessions.tenantId))
        .where(
          and(
            eq(sessions.tokenHash, hashToken(token)),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, new Date()),
            eq(users.status, 'active'),
            eq(tenants.status, 'active'),
          ),
        );
      if (!session) return null;
      return {
        tenantId,
        userId: session.userId,
        sessionId: session.id,
        permissions: new Set(await this.permissionsOf(tx, session.userId)),
        ...meta,
      };
    });
  }

  private async permissionsOf(tx: Tx, userId: string): Promise<string[]> {
    const rows = await tx
      .selectDistinct({ code: rolePermissions.permissionCode })
      .from(rolePermissions)
      .where(
        inArray(
          rolePermissions.roleId,
          tx.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId)),
        ),
      );
    return rows.map((row) => row.code).sort();
  }

  async logout(auth: AuthContext): Promise<void> {
    await this.database.withTenant(auth.tenantId, async (tx) => {
      await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, auth.sessionId));
      await this.audit.record(tx, auth, { action: 'auth.logout', entityType: 'user', entityId: auth.userId });
    });
  }

  me(auth: AuthContext): Promise<Me> {
    return this.database.withTenant(auth.tenantId, (tx) => this.loadMe(tx, auth.tenantId, auth.userId));
  }

  private async loadMe(tx: Tx, tenantId: string, userId: string): Promise<Me> {
    const [row] = await tx
      .select({
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        slug: tenants.slug,
        name: tenants.name,
        currency: tenants.currency,
        timezone: tenants.timezone,
      })
      .from(users)
      .innerJoin(tenants, eq(tenants.id, users.tenantId))
      .where(eq(users.id, userId));
    if (!row) throw new UnauthorizedException();
    return {
      user: { id: row.userId, email: row.email, fullName: row.fullName },
      tenant: { id: tenantId, slug: row.slug, name: row.name, currency: row.currency, timezone: row.timezone },
      permissions: await this.permissionsOf(tx, userId),
    };
  }
}
