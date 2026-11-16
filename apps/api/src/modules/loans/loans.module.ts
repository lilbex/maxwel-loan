import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module.js';
import { ApplicationsService } from './applications.service.js';
import { CollectionsService } from './collections.service.js';
import {
  ApplicationsController,
  CollectionsController,
  LoansController,
  PaymentsController,
} from './loans.controller.js';
import { LoansService } from './loans.service.js';
import { PenaltyJobs } from './penalty-jobs.js';
import { RepaymentsService } from './repayments.service.js';

@Module({
  imports: [LedgerModule],
  controllers: [ApplicationsController, LoansController, PaymentsController, CollectionsController],
  providers: [ApplicationsService, LoansService, RepaymentsService, CollectionsService, PenaltyJobs],
})
export class LoansModule {}
