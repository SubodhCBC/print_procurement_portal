import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { AppConfig } from '@/config';
import type { INestApplication } from '@nestjs/common';

/**
 * OpenAPI is the contract the frontend and the integration partners build
 * against, so it is generated from the code rather than maintained by hand.
 *
 * Disabled in production by config validation — publishing the full admin API
 * surface to the internet is free reconnaissance for an attacker.
 */
export function setupSwagger(app: INestApplication, config: AppConfig): string | undefined {
  if (!config.features.swagger) return undefined;

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Ticket-IT Portal API')
      .setDescription('B2B web-to-print procurement platform')
      .setVersion(config.app.release)
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
      .addServer(`/${config.app.globalPrefix}`)
      .build(),
  );

  const path = `${config.app.globalPrefix}/docs`;
  SwaggerModule.setup(path, app, document, {
    jsonDocumentUrl: `${path}/openapi.json`,
    swaggerOptions: { persistAuthorization: true },
  });

  return path;
}
