import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';
import { expand } from 'dotenv-expand';

/**
 * Walks up from `startDir` looking for the project root, so the app resolves
 * the same environment whether it is started from the repo root, from `dist/`,
 * or by a test runner with a different cwd.
 */
function findProjectRoot(startDir: string): string | undefined {
  let current = resolve(startDir);

  for (;;) {
    if (existsSync(resolve(current, 'nest-cli.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

let loaded = false;

/**
 * Loads environment files once per process, in descending priority:
 *
 *   1. the real process environment      (containers, CI — always wins)
 *   2. .env.local                        (personal overrides, git-ignored)
 *   3. .env                              (local secrets, git-ignored)
 *   4. src/config/env/.env.<APP_ENV>     (committed, non-secret defaults)
 *
 * Committed env files hold defaults only — ports, log levels, feature flags.
 * Secrets live in the git-ignored files locally and in the secret manager in
 * every deployed environment.
 *
 * A missing file is normal, not an error: a container has no `.env` at all.
 */
export function loadDotEnv(startDir: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;

  const root = findProjectRoot(startDir);
  if (!root) return;

  const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';

  const candidates = [
    resolve(root, '.env.local'),
    resolve(root, '.env'),
    resolve(root, 'src', 'config', 'env', `.env.${appEnv}`),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    // `override: false` keeps the first value that wins — hence the order above.
    expand(dotenv.config({ path, override: false }));
  }
}
