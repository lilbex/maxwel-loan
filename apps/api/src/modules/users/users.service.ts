import { ConflictException, Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { asc, eq, inArray } from 'drizzle-orm';
import type { CreateUserRequest, StaffMember } from '@loan-platform/api-client';
import { PG_UNIQUE_VIOLATION, pgError } from '../../common/errors.js';
import type { AuthContext } from '../../common/request-context.js';
import { DatabaseService } from '../../db/database.service.js';
import { roles, userRoles, users } from '../../db/schema.js';
import { AuditService } from '../audit/audit.service.js';

@Injectable()
export class UsersService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext): Promise<StaffMember[]> {
    return this.database.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx
        .select({ id: users.id, email: users.email, fullName: users.fullName, status: users.status, role: roles.name })
        .from(users)
        .leftJoin(userRoles, eq(userRoles.userId, users.id))
        .leftJoin(roles, eq(roles.id, userRoles.roleId))
        .orderBy(asc(users.fullName), asc(roles.name));
      const staff = new Map<string, StaffMember>();
      for (const { role, ...user } of rows) {
        const member = staff.get(user.id) ?? { ...user, roles: [] };
        if (role) member.roles.push(role);
        staff.set(user.id, member);
      }
      return [...staff.values()];
    });
  }

  roles(auth: AuthContext): Promise<string[]> {
    return this.database.withTenant(auth.tenantId, async (tx) =>
      (await tx.select({ name: roles.name }).from(roles).orderBy(asc(roles.name))).map((role) => role.name),
    );
  }

  async create(auth: AuthContext, input: CreateUserRequest) {
    const passwordHash = await hash(input.password);
    try {
      return await this.database.withTenant(auth.tenantId, async (tx) => {
        const matched = await tx.select().from(roles).where(inArray(roles.name, input.roleNames));
        if (matched.length !== new Set(input.roleNames).size) {
          throw new UnprocessableEntityException('One or more roles do not exist');
        }
        const [user] = await tx
          .insert(users)
          .values({
            tenantId: auth.tenantId,
            branchId: input.branchId,
            email: input.email,
            fullName: input.fullName,
            passwordHash,
          })
          .returning({ id: users.id, email: users.email, fullName: users.fullName, status: users.status });
        await tx
          .insert(userRoles)
          .values(matched.map((role) => ({ tenantId: auth.tenantId, userId: user!.id, roleId: role.id })));
        await this.audit.record(tx, auth, {
          action: 'user.created',
          entityType: 'user',
          entityId: user!.id,
          metadata: { roles: input.roleNames },
        });
        return { ...user!, roles: input.roleNames };
      });
    } catch (error) {
      if (pgError(error).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException('A staff account with this email already exists');
      }
      throw error;
    }
  }
}
