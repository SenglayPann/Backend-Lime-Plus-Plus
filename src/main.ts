import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { json, urlencoded, type Request, type Response } from 'express';
import { AppModule } from './app.module';
import { TransformInterceptor } from './common/interceptors';
import { HttpExceptionFilter } from './common/filters';

type RequestWithRawBody = Request & { rawBody?: Buffer };

function captureRawBody(req: RequestWithRawBody, _res: Response, buf: Buffer) {
  if (buf.length > 0) {
    req.rawBody = Buffer.from(buf);
  }
}

function resolveCorsOrigin(isProduction: boolean) {
  const configuredOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configuredOrigins.length === 0) {
    if (isProduction) {
      throw new Error('FRONTEND_URL must be configured in production');
    }
    return 'http://localhost:3000';
  }

  return configuredOrigins.length === 1 ? configuredOrigins[0] : configuredOrigins;
}

async function bootstrap() {
  const isProduction = process.env.NODE_ENV === 'production';
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
  });

  app.use(
    helmet({
      contentSecurityPolicy: isProduction ? undefined : false,
    }),
  );

  app.use(
    '/api/v1/webhooks/github',
    json({
      limit: process.env.WEBHOOK_BODY_LIMIT || '5mb',
      verify: captureRawBody,
    }),
  );
  app.use(
    json({
      limit: process.env.API_BODY_LIMIT || '1mb',
      verify: captureRawBody,
    }),
  );
  app.use(
    urlencoded({
      extended: true,
      limit: process.env.API_BODY_LIMIT || '1mb',
      verify: captureRawBody,
    }),
  );

  // Set global prefix
  app.setGlobalPrefix('api/v1');

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Global response transformation (wraps in { success: true, data: ... })
  app.useGlobalInterceptors(new TransformInterceptor());

  // Global exception filter (formats errors as { success: false, error: { code, message } })
  app.useGlobalFilters(new HttpExceptionFilter());

  if (!isProduction) {
    const config = new DocumentBuilder()
      .setTitle('Lime++ API')
      .setDescription('The contribution verification and evaluation system API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  // Enable CORS for frontend
  app.enableCors({
    origin: resolveCorsOrigin(isProduction),
    credentials: true,
  });

  await app.listen(process.env.PORT ?? 3001);
  console.log(
    `Backend running on http://localhost:${process.env.PORT ?? 3001}/api/v1`,
  );
  if (!isProduction) {
    console.log(
      `Swagger docs available at http://localhost:${process.env.PORT ?? 3001}/api/docs`,
    );
  }
}
bootstrap().catch((err) => {
  console.error('Failed to start application', err);
  process.exit(1);
});
