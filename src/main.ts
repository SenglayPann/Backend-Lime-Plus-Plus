import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { TransformInterceptor } from './common/interceptors';
import { HttpExceptionFilter } from './common/filters';

async function bootstrap() {
  const isProduction = process.env.NODE_ENV === 'production';
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  app.use(
    helmet({
      contentSecurityPolicy: isProduction ? undefined : false,
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
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
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
