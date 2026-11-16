import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
  applicationStatuses,
  type CollectionNoteRequest,
  collectionNoteRequest,
  type DecisionRequest,
  decisionRequest,
  type DisburseRequest,
  disburseRequest,
  type ExistingLoanRequest,
  existingLoanRequest,
  type LoanApplicationRequest,
  loanApplicationRequest,
  type RecordPaymentRequest,
  recordPaymentRequest,
  type ReversePaymentRequest,
  reversePaymentRequest,
  type WaivePenaltyRequest,
  waivePenaltyRequest,
} from '@loan-platform/api-client';
import { Auth, type AuthContext, RequirePermissions } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { ApplicationsService } from './applications.service.js';
import { CollectionsService } from './collections.service.js';
import { LoansService } from './loans.service.js';
import { RepaymentsService } from './repayments.service.js';

const statusQuery = z.enum(applicationStatuses).optional();
const borrowerQuery = z.uuid().optional();

function requireKey(key: string | undefined): string {
  if (!key || key.length < 8 || key.length > 128) {
    throw new BadRequestException('Idempotency-Key header is required (8 to 128 characters)');
  }
  return key;
}

@Controller('loan-applications')
export class ApplicationsController {
  constructor(@Inject(ApplicationsService) private readonly applications: ApplicationsService) {}

  @Post('existing/preview')
  @HttpCode(200)
  @RequirePermissions('loans.apply')
  previewExisting(@Auth() auth: AuthContext, @Body(new ZodPipe(existingLoanRequest)) body: ExistingLoanRequest) {
    return this.applications.previewExisting(auth, body);
  }

  @Post('existing')
  @RequirePermissions('loans.apply')
  createExisting(@Auth() auth: AuthContext, @Body(new ZodPipe(existingLoanRequest)) body: ExistingLoanRequest) {
    return this.applications.createExisting(auth, body);
  }

  @Put('existing/:id')
  @RequirePermissions('loans.apply')
  updateExisting(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(existingLoanRequest)) body: ExistingLoanRequest,
  ) {
    return this.applications.updateExisting(auth, id, body);
  }

  @Get()
  @RequirePermissions('loans.read')
  list(
    @Auth() auth: AuthContext,
    @Query('status', new ZodPipe(statusQuery)) status?: z.infer<typeof statusQuery>,
    @Query('borrowerId', new ZodPipe(borrowerQuery)) borrowerId?: string,
  ) {
    return this.applications.list(auth, { status, borrowerId });
  }

  @Post()
  @RequirePermissions('loans.apply')
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(loanApplicationRequest)) body: LoanApplicationRequest) {
    return this.applications.create(auth, body);
  }

  @Get(':id')
  @RequirePermissions('loans.read')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.applications.get(auth, id);
  }

  @Put(':id')
  @RequirePermissions('loans.apply')
  update(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(loanApplicationRequest)) body: LoanApplicationRequest,
  ) {
    return this.applications.update(auth, id, body);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermissions('loans.apply')
  submit(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.applications.submit(auth, id);
  }

  @Post(':id/decision')
  @HttpCode(200)
  @RequirePermissions('loans.approve')
  decide(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(decisionRequest)) body: DecisionRequest,
  ) {
    return this.applications.decide(auth, id, body);
  }
}

@Controller('loans')
export class LoansController {
  constructor(
    @Inject(LoansService) private readonly loans: LoansService,
    @Inject(RepaymentsService) private readonly repayments: RepaymentsService,
    @Inject(CollectionsService) private readonly collections: CollectionsService,
  ) {}

  @Get('opening-summary')
  @RequirePermissions('loans.read')
  openingSummary(@Auth() auth: AuthContext) {
    return this.loans.openingSummary(auth);
  }

  @Post(':id/penalty-waivers')
  @RequirePermissions('penalties.manage')
  async waive(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(waivePenaltyRequest)) body: WaivePenaltyRequest,
  ) {
    await this.collections.waive(auth, id, body);
    return this.loans.get(auth, id);
  }

  @Post(':id/collection-notes')
  @RequirePermissions('collections.manage')
  addNote(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(collectionNoteRequest)) body: CollectionNoteRequest,
  ) {
    return this.collections.addNote(auth, id, body);
  }

  @Post(':id/payments')
  @RequirePermissions('payments.record')
  recordPayment(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(recordPaymentRequest)) body: RecordPaymentRequest,
  ) {
    return this.repayments.record(auth, id, requireKey(key), body);
  }

  @Get(':id/statement')
  @RequirePermissions('loans.read')
  statement(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.repayments.statement(auth, id);
  }

  @Get()
  @RequirePermissions('loans.read')
  list(@Auth() auth: AuthContext, @Query('borrowerId', new ZodPipe(borrowerQuery)) borrowerId?: string) {
    return this.loans.list(auth, { borrowerId });
  }

  @Get(':id')
  @RequirePermissions('loans.read')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.loans.get(auth, id);
  }

  @Post(':id/disburse')
  @HttpCode(200)
  @RequirePermissions('loans.disburse')
  disburse(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(disburseRequest)) body: DisburseRequest,
  ) {
    return this.loans.disburse(auth, id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('loans.approve')
  cancel(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.loans.cancel(auth, id);
  }
}

@Controller('payments')
export class PaymentsController {
  constructor(@Inject(RepaymentsService) private readonly repayments: RepaymentsService) {}

  @Get()
  @RequirePermissions('loans.read')
  list(@Auth() auth: AuthContext) {
    return this.repayments.list(auth);
  }

  @Get(':id')
  @RequirePermissions('loans.read')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.repayments.get(auth, id);
  }

  @Post(':id/reverse')
  @RequirePermissions('payments.reverse')
  reverse(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(reversePaymentRequest)) body: ReversePaymentRequest,
  ) {
    return this.repayments.reverse(auth, id, requireKey(key), body);
  }
}

@Controller('collections')
export class CollectionsController {
  constructor(@Inject(CollectionsService) private readonly collections: CollectionsService) {}

  @Get()
  @RequirePermissions('loans.read')
  report(@Auth() auth: AuthContext) {
    return this.collections.report(auth);
  }

  @Post('apply-penalties')
  @HttpCode(200)
  @RequirePermissions('penalties.manage')
  applyPenalties(@Auth() auth: AuthContext) {
    return this.collections.applyNow(auth);
  }
}
