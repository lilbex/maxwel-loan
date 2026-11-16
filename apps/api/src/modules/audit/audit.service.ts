import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { AuditEvent } from '@loan-platform/api-client';
import type { AuthContext } from '../../common/request-context.js';
import { DatabaseService, type Tx } from '../../db/database.service.js';
import { auditEvents, users } from '../../db/schema.js';

export interface AuditRecord {
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

type Actor = Pick<AuthContext, 'tenantId' | 'ipAddress' | 'userAgent'> & { userId: string | null };

@Injectable()
export class AuditService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Takes the caller's transaction, so an action and its audit record commit or fail together. */
  async record(tx: Tx, actor: Actor, record: AuditRecord): Promise<void> {
    await tx.insert(auditEvents).values({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: record.action,
      entityType: record.entityType,
      entityId: record.entityId,
      metadata: record.metadata ?? {},
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  }

  list(auth: AuthContext, limit: number): Promise<AuditEvent[]> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: auditEvents.id,
          action: auditEvents.action,
          actorName: users.fullName,
          entityType: auditEvents.entityType,
          entityId: auditEvents.entityId,
          createdAt: auditEvents.createdAt,
        })
        .from(auditEvents)
        .leftJoin(users, eq(users.id, auditEvents.actorUserId))
        .orderBy(desc(auditEvents.createdAt))
        .limit(limit);
      return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    });
  }
}
