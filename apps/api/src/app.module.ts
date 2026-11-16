import { type DynamicModule, Global, Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_CONFIG, type AppConfig } from './config.js';
import { DatabaseModule } from './db/database.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BorrowersModule } from './modules/borrowers/borrowers.module.js';
import { HealthController } from './modules/health/health.controller.js';
import { LedgerModule } from './modules/ledger/ledger.module.js';
import { LoanProductsModule } from './modules/loan-products/loan-products.module.js';
import { LoansModule } from './modules/loans/loans.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { UsersModule } from './modules/users/users.module.js';

@Global()
@Module({})
class ConfigModule {
  static register(config: AppConfig): DynamicModule {
    const provider = { provide: APP_CONFIG, useValue: config };
    return { module: ConfigModule, providers: [provider], exports: [provider] };
  }
}

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.register(config),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: config.LOGIN_RATE_LIMIT_PER_MINUTE }]),
        DatabaseModule,
        AuditModule,
        AuthModule,
        UsersModule,
        LedgerModule,
        LoanProductsModule,
        BorrowersModule,
        LoansModule,
        ReportsModule,
      ],
      controllers: [HealthController],
    };
  }
}
