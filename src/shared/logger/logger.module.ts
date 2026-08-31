import { Module, type DynamicModule } from '@nestjs/common';
import { loadConfig } from '@/config';
import { getRequestContext } from '@/common';
import { LoggerModule } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface LoggerOptions {
  /**
   * Automatically log every HTTP request/response. On for the API; off for the
   * workers, whose only HTTP surface is the probe endpoints.
   */
  readonly httpLogging: boolean;
}

/**
 * Structured logging, shared by every process.
 *
 * Two rules this configuration enforces:
 *  1. Every line carries `requestId` (and, once authenticated, `accountId` and
 *     `userId`) so a support ticket can be traced end to end.
 *  2. Credentials never reach the log sink. Redaction happens here, at the
 *     boundary, rather than relying on every call site to remember.
 */
@Module({})
export class AppLoggerModule {
  static forRoot(options: LoggerOptions = { httpLogging: false }): DynamicModule {
    const config = loadConfig();

    return {
      module: AppLoggerModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.observability.logLevel,
            // Pretty output is a local-only convenience; deployed environments
            // emit newline-delimited JSON for the log aggregator.
            transport: config.observability.logPretty
              ? {
                  target: 'pino-pretty',
                  options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' },
                }
              : undefined,

            // Fastify already generated a request id; reuse it as the correlation id.
            genReqId: (req: IncomingMessage) => (req as IncomingMessage & { id?: string }).id,

            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-api-key"]',
                'req.headers["x-webhook-signature"]',
                'res.headers["set-cookie"]',
                'req.body.password',
                'req.body.currentPassword',
                'req.body.newPassword',
                'req.body.token',
                'req.body.refreshToken',
                '*.secretAccessKey',
                '*.hmacSecret',
              ],
              censor: '[redacted]',
            },

            customProps: () => {
              const context = getRequestContext();
              if (!context?.actor) return {};
              return {
                accountId: context.actor.accountId,
                userId: context.actor.userId,
                siteId: context.actor.siteId,
                role: context.actor.role,
              };
            },

            serializers: {
              req: (req: IncomingMessage & { id?: string }) => ({
                id: req.id,
                method: req.method,
                url: req.url,
              }),
              res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
            },

            // Health probes would otherwise dominate the log volume.
            autoLogging: options.httpLogging
              ? { ignore: (req: IncomingMessage) => (req.url ?? '').startsWith('/health') }
              : false,

            customLogLevel: (_req, res, error) => {
              if (error || res.statusCode >= 500) return 'error';
              if (res.statusCode >= 400) return 'warn';
              return 'info';
            },
          },
        }),
      ],
      exports: [LoggerModule],
    };
  }
}
