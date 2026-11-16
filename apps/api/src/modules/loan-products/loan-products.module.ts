import { Module } from '@nestjs/common';
import { LoanProductsController } from './loan-products.controller.js';
import { LoanProductsService } from './loan-products.service.js';

@Module({ controllers: [LoanProductsController], providers: [LoanProductsService], exports: [LoanProductsService] })
export class LoanProductsModule {}
