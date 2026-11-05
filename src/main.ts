import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ErrorResponseFilter } from './common/error-response.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Behind Caddy: use the forwarded client IP so rate limits apply per user, not per proxy.
  app.set('trust proxy', 1);
  app.enableCors();
  app.useGlobalFilters(new ErrorResponseFilter());
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
