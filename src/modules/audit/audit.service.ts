import { Injectable, Logger } from '@nestjs/common';
import type { AuditEntityType, Prisma } from '@prisma/client';
import {
  createId,
  getRequestContext,
  offsetPage,
  toSkipTake,
  type AuthenticatedActor,
  type OffsetPage,
  type OffsetPageRequest,
} from '@/common';
import { PrismaService, withTenantScope } from '@/database';
import { REDACTED_FIELDS, REDACTED_PLACEHOLDER, type AuditAction } from './audit.actions';

export interface AuditRecordInput {
  readonly action: AuditAction;
  readonly entityType: AuditEntityType;
  readonly entityId: string;
  /** Human label at the time of the action, so the log survives a rename. */
  readonly entityName?: string;
  /** Changed fields and context. Redacted before it is stored. */
  readonly details?: Record<string, unknown>;
  /**
   * Which tenant the entry belongs to. Defaults to the actor's account, and is
   * passed explicitly only when an ADMIN acts on another tenant — the entry
   * belongs in *their* log, not the admin's.
   */
  readonly accountId?: string;
  /**
   * Overrides the ambient actor. Used by the two flows that write an audit
   * entry for someone who is not the authenticated caller: invitation
   * acceptance, where the caller is anonymous, and legacy provisioning.
   */
  readonly actor?: AuditActor;
}

export interface AuditActor {
  readonly userId: string | null;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly accountId: string;
}

/** For a scheduled job, a webhook, or a migration — nobody pressed a button. */
export const SYSTEM_ACTOR = (accountId: string): AuditActor => ({
  userId: null,
  name: 'System',
  email: 'system@ticketit.local',
  role: 'SYSTEM',
  accountId,
});

export interface AuditQuery extends OffsetPageRequest {
  readonly actorId?: string;
  readonly entityType?: AuditEntityType;
  readonly entityId?: string;
  readonly action?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly search?: string;
}

/**
 * Writes and reads the audit trail.
 *
 * There is no update and no delete, here or on the controller. That is the only
 * sense in which the log is immutable — the database is not asked to enforce
 * it, because the role that runs migrations could drop whatever trigger did,
 * so a trigger would buy the appearance of a guarantee rather than the thing.
 *
 * `record()` never throws. An audit write failing must not roll back the
 * business change that succeeded: an order that was approved and not logged is
 * a gap in the trail, while an order that was refused because the trail was
 * unavailable is an outage. The failure is logged at error level so it is
 * visible, and the caller carries on.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records one entry. Fire-and-forget from the caller's point of view.
   *
   * Deliberately NOT inside the caller's transaction. Sharing it would make the
   * audit write able to abort the business change, which is the failure mode
   * the whole method is written to avoid. The cost is that a rolled-back
   * transaction can leave an entry describing something that did not happen —
   * which is why callers record *after* their write commits, never before.
   */
  async record(input: AuditRecordInput): Promise<void> {
    const actor = input.actor ?? this.actorFromContext();
    if (!actor) {
      this.logger.error(
        `Cannot record "${input.action}" on ${input.entityType} ${input.entityId}: ` +
          'no actor in the request context and none supplied.',
      );
      return;
    }

    const accountId = input.accountId ?? actor.accountId;
    const context = getRequestContext();

    try {
      await withTenantScope(this.prisma, accountId, (tx) =>
        tx.auditLogEntry.create({
          data: {
            id: createId('aud'),
            accountId,
            // Null rather than the id when the actor belongs to a different
            // account than the entry: the foreign key is to `users`, which RLS
            // has scoped to this tenant, so the row would be unresolvable.
            actorId: actor.accountId === accountId ? actor.userId : null,
            actorName: actor.name,
            actorEmail: actor.email,
            actorRole: actor.role,
            action: input.action,
            entityType: input.entityType,
            entityId: input.entityId,
            entityName: input.entityName ?? null,
            details: (redact(input.details) ?? null) as Prisma.InputJsonValue,
            ipAddress: context?.ip ?? null,
            userAgent: context?.userAgent ?? null,
            requestId: context?.requestId ?? null,
          },
        }),
      );
    } catch (error) {
      this.logger.error(
        `Failed to record audit entry "${input.action}" for ${input.entityType} ` +
          `${input.entityId} in account ${accountId}. The change itself succeeded.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async list(accountId: string, query: AuditQuery): Promise<OffsetPage<AuditEntry>> {
    const where: Prisma.AuditLogEntryWhereInput = {
      accountId,
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { actorName: { contains: query.search, mode: 'insensitive' } },
              { actorEmail: { contains: query.search, mode: 'insensitive' } },
              { entityName: { contains: query.search, mode: 'insensitive' } },
              { entityId: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const { skip, take } = toSkipTake(query);

    return withTenantScope(this.prisma, accountId, async (tx) => {
      // Both inside the tenant scope, so the count and the rows are filtered by
      // the same RLS policy — a count taken outside it would report totals the
      // caller is not allowed to see.
      const [rows, total] = await Promise.all([
        tx.auditLogEntry.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take,
        }),
        tx.auditLogEntry.count({ where }),
      ]);

      return offsetPage(rows, total, query);
    });
  }

  /** Every entry touching one object, newest first. Used by entity detail views. */
  async listForEntity(
    accountId: string,
    entityType: AuditEntityType,
    entityId: string,
    limit = 50,
  ): Promise<AuditEntry[]> {
    return withTenantScope(this.prisma, accountId, (tx) =>
      tx.auditLogEntry.findMany({
        where: { accountId, entityType, entityId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    );
  }

  /**
   * The authenticated caller, as an audit actor.
   *
   * The name is built from the token's email rather than a database lookup:
   * `record()` is called on the hot path of every mutation, and a join per
   * entry to fetch a display name the token already implies is not worth it.
   * Services that have the user row loaded should pass `actor` explicitly.
   */
  private actorFromContext(): AuditActor | undefined {
    const actor: AuthenticatedActor | undefined = getRequestContext()?.actor;
    if (!actor) return undefined;

    return {
      userId: actor.userId,
      name: actor.email,
      email: actor.email,
      role: actor.role,
      accountId: actor.accountId,
    };
  }
}

export type AuditEntry = Prisma.AuditLogEntryGetPayload<Record<string, never>>;

/**
 * Strips secrets from the details blob, at any depth.
 *
 * Recursive because callers pass nested before/after objects, and a token one
 * level down is just as sensitive as one at the top. Depth is bounded so a
 * cyclic or pathological object cannot hang the request that is only trying to
 * write a log line.
 */
function redact(value: Record<string, unknown> | undefined, depth = 0): unknown {
  if (value === undefined) return undefined;
  return redactValue(value, depth);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 8) return REDACTED_PLACEHOLDER;
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = REDACTED_FIELDS.has(key) ? REDACTED_PLACEHOLDER : redactValue(entry, depth + 1);
  }
  return result;
}

export { redact as redactAuditDetails };
