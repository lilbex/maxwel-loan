import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { AppConfig } from './config.js';

export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  app.enableShutdownHooks();
}
