import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../config.js';
import { CollectionsService } from './collections.service.js';

const QUEUE = 'daily-penalties';

/**
 * Schedules the daily penalty run. BullMQ keeps one schedule in Redis, so several API instances
 * still run it once. If a run is missed, the next one catches up, because the job adds whatever
 * charges are absent. Requests carry on normally if Redis is down.
 */
@Injectable()
export class PenaltyJobs implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PenaltyJobs.name);
  private queue?: Queue;
  private worker?: Worker;
  private lastRedisWarning = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CollectionsService) private readonly collections: CollectionsService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.JOBS_ENABLED) return;
    const url = new URL(this.config.REDIS_URL);
    const connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password || undefined,
      maxRetriesPerRequest: null,
    };

    this.queue = new Queue(QUEUE, { connection });
    this.queue.on('error', (error) => this.warnRedis(error));
    this.worker = new Worker(
      QUEUE,
      async () => {
        const result = await this.collections.applyForAllTenants();
        this.logger.log(`Penalties applied: ${result.chargesAdded} charges on ${result.loansCharged} loans`);
        return result;
      },
      { connection },
    );
    this.worker.on('error', (error) => this.warnRedis(error));
    this.worker.on('failed', (_, error) => this.logger.error(`Penalty run failed: ${error.message}`));

    // Not awaited: startup must not wait for Redis.
    void this.queue
      .upsertJobScheduler(
        'daily',
        { pattern: this.config.PENALTY_SCHEDULE, tz: 'Africa/Lagos' },
        { name: 'apply', opts: { attempts: 5, backoff: { type: 'exponential', delay: 60_000 } } },
      )
      .catch((error: Error) => this.logger.warn(`Could not schedule penalties: ${error.message}`));
  }

  /** Redis errors repeat every second while it is down, so this logs at most once a minute. */
  private warnRedis(error: Error): void {
    const now = Date.now();
    if (now - this.lastRedisWarning < 60_000) return;
    this.lastRedisWarning = now;
    this.logger.warn(`Penalty job cannot reach Redis, so the daily run is paused: ${error.message}`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
