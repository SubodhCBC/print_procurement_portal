import { Global, Module } from '@nestjs/common';
import { loadConfig } from './configuration';
import type { AppConfig } from './configuration';

/** Injection token for the validated, immutable application configuration. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * Deliberately not @nestjs/config: the environment is already parsed and
 * validated by this library, so the module only publishes the result to the DI
 * container. One schema, one parse, one shape — shared by the API and both
 * workers.
 */
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() }],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
