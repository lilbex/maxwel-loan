import { BadRequestException, Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  type CreateAccountRequest,
  createAccountRequest,
  isoDate,
  type OpeningCashRequest,
  openingCashRequest,
  type PostEntryRequest,
  postEntryRequest,
  type ReverseEntryRequest,
  reverseEntryRequest,
} from '@loan-platform/api-client';
import { Auth, type AuthContext, RequirePermissions } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { LedgerService } from './ledger.service.js';

function requireKey(key: string | undefined): string {
  if (!key || key.length < 8 || key.length > 128) {
    throw new BadRequestException('Idempotency-Key header is required (8 to 128 characters)');
  }
  return key;
}

@Controller('ledger')
export class LedgerController {
  constructor(@Inject(LedgerService) private readonly ledger: LedgerService) {}

  @Get('accounts')
  @RequirePermissions('ledger.read')
  accounts(@Auth() auth: AuthContext) {
    return this.ledger.listAccounts(auth);
  }

  @Post('accounts')
  @RequirePermissions('accounts.manage')
  createAccount(@Auth() auth: AuthContext, @Body(new ZodPipe(createAccountRequest)) body: CreateAccountRequest) {
    return this.ledger.createAccount(auth, body);
  }

  @Post('entries')
  @RequirePermissions('ledger.post')
  post(
    @Auth() auth: AuthContext,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(postEntryRequest)) body: PostEntryRequest,
  ) {
    return this.ledger.postManual(auth, requireKey(key), body);
  }

  @Post('opening-cash')
  @RequirePermissions('ledger.post')
  openingCash(
    @Auth() auth: AuthContext,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(openingCashRequest)) body: OpeningCashRequest,
  ) {
    return this.ledger.postOpeningCash(auth, requireKey(key), body);
  }

  @Get('entries/:id')
  @RequirePermissions('ledger.read')
  entry(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.ledger.getEntry(auth, id);
  }

  @Post('entries/:id/reversals')
  @RequirePermissions('ledger.reverse')
  reverse(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(reverseEntryRequest)) body: ReverseEntryRequest,
  ) {
    return this.ledger.reverse(auth, id, requireKey(key), body);
  }

  @Get('trial-balance')
  @RequirePermissions('ledger.read')
  trialBalance(@Auth() auth: AuthContext, @Query('asOf', new ZodPipe(isoDate.optional())) asOf?: string) {
    return this.ledger.trialBalance(auth, asOf);
  }
}
