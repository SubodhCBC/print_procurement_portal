import type { AuditEntry } from '../audit.service';

/**
 * An audit entry as the API exposes it.
 *
 * Matches the reference portal's `AuditLogEntry` shape so the admin explorer
 * can consume it directly, with two deliberate additions: `userAgent` and
 * `requestId`. The request id is what ties an entry to the structured logs for
 * the same request, which is the difference between "someone changed this" and
 * being able to reconstruct what else happened in that call.
 */
export interface AuditLogEntryView {
  readonly id: string;
  readonly actorId: string | null;
  readonly actorName: string;
  readonly actorEmail: string;
  readonly actorRole: string;
  readonly action: string;
  readonly entityType: AuditEntry['entityType'];
  readonly entityId: string;
  readonly entityName: string | null;
  readonly details: unknown;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  /**
   * Named `timestamp`, not `createdAt`: an audit entry records when the thing
   * happened, and it is never updated, so there is no pair to distinguish.
   */
  readonly timestamp: string;
}

export function toAuditLogEntryView(entry: AuditEntry): AuditLogEntryView {
  return {
    id: entry.id,
    actorId: entry.actorId,
    actorName: entry.actorName,
    actorEmail: entry.actorEmail,
    actorRole: entry.actorRole,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    entityName: entry.entityName,
    details: entry.details ?? null,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    requestId: entry.requestId,
    timestamp: entry.createdAt.toISOString(),
  };
}
