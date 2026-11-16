import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../../common/request-context.js';
import { DatabaseService } from '../../db/database.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Public()
  @Get()
  async check() {
    await this.database.ping();
    return { status: 'ok' };
  }
}
