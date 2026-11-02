import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ErrorResponseFilter } from './common/error-response.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors();
  app.useGlobalFilters(new ErrorResponseFilter());
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
