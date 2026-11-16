import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import {
  type LoanProductRequest,
  loanProductRequest,
  productStatusRequest,
  type SchedulePreviewRequest,
  schedulePreviewRequest,
} from '@loan-platform/api-client';
import { Auth, type AuthContext, RequirePermissions } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { LoanProductsService } from './loan-products.service.js';

@Controller('loan-products')
export class LoanProductsController {
  constructor(@Inject(LoanProductsService) private readonly products: LoanProductsService) {}

  @Get()
  @RequirePermissions('products.read')
  list(@Auth() auth: AuthContext) {
    return this.products.list(auth);
  }

  @Post()
  @RequirePermissions('products.manage')
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(loanProductRequest)) body: LoanProductRequest) {
    return this.products.create(auth, body);
  }

  @Get(':id')
  @RequirePermissions('products.read')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.products.get(auth, id);
  }

  @Put(':id')
  @RequirePermissions('products.manage')
  update(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(loanProductRequest)) body: LoanProductRequest,
  ) {
    return this.products.update(auth, id, body);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermissions('products.manage')
  setStatus(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(productStatusRequest)) body: { status: 'active' | 'archived' },
  ) {
    return this.products.setStatus(auth, id, body.status);
  }

  @Post(':id/schedule-preview')
  @HttpCode(200)
  @RequirePermissions('products.read')
  preview(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(schedulePreviewRequest)) body: SchedulePreviewRequest,
  ) {
    return this.products.preview(auth, id, body);
  }
}
