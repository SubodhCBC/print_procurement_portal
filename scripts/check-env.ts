/**
 * Validates an environment without starting the application.
 *
 *   pnpm tsx scripts/check-env.ts            # current environment
 *   APP_ENV=production pnpm tsx scripts/check-env.ts
 *
 * Useful as a pre-deploy gate: it fails with the full list of problems before
 * a container is ever rolled out, instead of crash-looping in the cluster.
 */
import { ConfigValidationError, loadConfig } from '../src/config';

try {
  const config = loadConfig();
  console.log(`✔ configuration valid for APP_ENV=${config.app.env}`);
  console.log(`  api        : ${config.app.host}:${config.app.port}/${config.app.globalPrefix}`);
  console.log(`  database   : ${new URL(config.database.url).host}`);
  console.log(`  redis      : ${new URL(config.redis.url).host}`);
  console.log(`  swagger    : ${config.features.swagger ? 'enabled' : 'disabled'}`);
  console.log(`  role switch: ${config.features.roleSwitcher ? 'ENABLED' : 'disabled'}`);
} catch (error) {
  if (error instanceof ConfigValidationError) {
    console.error(error.message);
    process.exit(78); // EX_CONFIG
  }
  throw error;
}
