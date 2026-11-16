import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config));
configureApp(app, config);
await app.listen(config.PORT);
console.log(`API listening on port ${config.PORT}`);
