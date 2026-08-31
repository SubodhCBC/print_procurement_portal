import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestContext } from '../interfaces/request-context.interface';

/**
 * Ambient request state. Nothing outside this module touches the storage
 * directly — the helpers below are the whole public surface.
 *
 * Why AsyncLocalStorage instead of threading a context argument through every
 * service: the tenant id is needed by layers the caller never sees (the Prisma
 * tenant guard, the audit logger, the log formatter). Passing it by hand means
 * exactly one forgotten parameter becomes a cross-tenant data leak.
 */
const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Returns undefined outside a request — e.g. in a worker job or a CLI script. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function requireRequestContext(): RequestContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error('No request context is active — did this run outside the request pipeline?');
  }
  return context;
}

/** The active tenant, or undefined on public/unauthenticated routes. */
export function getCurrentAccountId(): string | undefined {
  return storage.getStore()?.actor?.accountId;
}

export function getCurrentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
