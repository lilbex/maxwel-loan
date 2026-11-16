import { Controller, Get, Inject, Query } from '@nestjs/common';
import { isoDate } from '@loan-platform/api-client';
import { Auth, type AuthContext, RequirePermissions } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { ReportsService } from './reports.service.js';

@Controller('reports')
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  @Get('portfolio')
  @RequirePermissions('reports.read')
  portfolio(@Auth() auth: AuthContext) {
    return this.reports.portfolio(auth);
  }

  @Get('collected')
  @RequirePermissions('reports.read')
  collected(
    @Auth() auth: AuthContext,
    @Query('from', new ZodPipe(isoDate)) from: string,
    @Query('to', new ZodPipe(isoDate)) to: string,
  ) {
    return this.reports.collected(auth, from, to);
  }

  @Get('disbursements')
  @RequirePermissions('reports.read')
  disbursements(
    @Auth() auth: AuthContext,
    @Query('from', new ZodPipe(isoDate)) from: string,
    @Query('to', new ZodPipe(isoDate)) to: string,
  ) {
    return this.reports.disbursements(auth, from, to);
  }

  @Get('financials')
  @RequirePermissions('reports.read')
  financials(
    @Auth() auth: AuthContext,
    @Query('from', new ZodPipe(isoDate)) from: string,
    @Query('to', new ZodPipe(isoDate)) to: string,
  ) {
    return this.reports.financials(auth, from, to);
  }
}
