import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { type BorrowerRequest, borrowerRequest } from '@loan-platform/api-client';
import { Auth, type AuthContext, RequirePermissions } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { BorrowersService } from './borrowers.service.js';

const searchQuery = z.string().trim().max(100).default('');

@Controller('borrowers')
export class BorrowersController {
  constructor(@Inject(BorrowersService) private readonly borrowers: BorrowersService) {}

  @Get()
  @RequirePermissions('borrowers.read')
  list(@Auth() auth: AuthContext, @Query('search', new ZodPipe(searchQuery)) search: string) {
    return this.borrowers.list(auth, search);
  }

  @Post()
  @RequirePermissions('borrowers.manage')
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(borrowerRequest)) body: BorrowerRequest) {
    return this.borrowers.create(auth, body);
  }

  @Get(':id')
  @RequirePermissions('borrowers.read')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.borrowers.get(auth, id);
  }

  @Put(':id')
  @RequirePermissions('borrowers.manage')
  update(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(borrowerRequest)) body: BorrowerRequest,
  ) {
    return this.borrowers.update(auth, id, body);
  }
}
