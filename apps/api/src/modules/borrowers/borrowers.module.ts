import { Module } from '@nestjs/common';
import { BorrowersController } from './borrowers.controller.js';
import { BorrowersService } from './borrowers.service.js';

@Module({ controllers: [BorrowersController], providers: [BorrowersService] })
export class BorrowersModule {}
