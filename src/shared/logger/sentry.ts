import * as Sentry from '@sentry/node';
import type { AppConfig } from '@/config';

/**
 * Initialised before the Nest application is created so that errors thrown
 * during bootstrap (a failed migration check, an unreachable database) are
 * still reported.
 *
 * A missing DSN is normal locally and must not be fatal.
 */
export function initSentry(config: AppConfig): void {
  if (!config.observability.sentryDsn) return;

  Sentry.init({
    dsn: config.observability.sentryDsn,
    environment: config.app.env,
    release: config.app.release,
    tracesSampleRate: config.observability.sentryTracesSampleRate,
    // Tenant data must never leave the platform inside a crash report.
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      return event;
    },
  });
}

export { Sentry };
