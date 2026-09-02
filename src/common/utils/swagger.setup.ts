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
      // No .addServer(globalPrefix): the generated paths already carry it
      // (`/api/v1/auth/login`), so declaring it as a server base as well makes
      // Swagger UI issue `/api/api/v1/...` and 404. It also broke the health
      // probes, which are excluded from the prefix and live at `/health/*` —
      // a server base would have sent those to `/api/health/*`.
      .build(),
  );

  const path = `${config.app.globalPrefix}/docs`;
  SwaggerModule.setup(path, app, document, {
    jsonDocumentUrl: `${path}/openapi.json`,
    swaggerOptions: { persistAuthorization: true },
  });

  return path;
}
