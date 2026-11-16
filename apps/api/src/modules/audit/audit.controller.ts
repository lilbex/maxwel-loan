import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { Auth, type AuthContext, RequirePermissions } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { AuditService } from './audit.service.js';

const limitQuery = z.coerce.number().int().min(1).max(200).default(50);

@Controller('audit-events')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit.read')
  list(@Auth() auth: AuthContext, @Query('limit', new ZodPipe(limitQuery)) limit: number) {
    return this.audit.list(auth, limit);
  }
}
