import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DependencyUnavailableError,
  ForbiddenError,
  NotFoundError,
  Permission,
  type AuthenticatedActor,
} from '@/common';
import { APP_CONFIG, type AppConfig } from '@/config';
import { AuditAction, AuditService } from '@/modules/audit';
import type { DamDocument, DamDownload, DamListPage, DamListQuery } from './dam.types';

/**
 * The single boundary between this system and the DAM (ARCH section 8).
 *
 * ---------------------------------------------------------------------------
 * Why this exists before the DAM does
 * ---------------------------------------------------------------------------
 * The DAM's endpoints and credentials are not available yet. What *is* settled
 * is everything on this side of the wire: which permission gates a read, that
 * every access is audited, that no caller ever learns the DAM's internals, and
 * that a document reaches the browser as a short-lived link rather than through
 * this process.
 *
 * Building that now means the day credentials arrive is a config change and one
 * transport method, not a design conversation. Until then every call fails
 * loudly with a message that says exactly what is missing — the one thing worse
 * than an unavailable dependency is one that silently returns nothing and lets
 * a gallery render as empty rather than as broken.
 *
 * ---------------------------------------------------------------------------
 * Three rules that do not move
 * ---------------------------------------------------------------------------
 * 1. **Permission before anything else.** `DAM_VIEW` to read, `DAM_DOWNLOAD` to
 *    fetch bytes, `DAM_UPLOAD` to write. Checked here rather than only on the
 *    route, because this service will eventually be called by the template
 *    renderer and by INT-01, neither of which goes through a controller.
 *
 * 2. **Every access is audited.** ARCH asks for it, and it is the only way to
 *    answer "who took the patient-facing artwork" after the fact. The audit
 *    entry is written for reads too, not only writes — a DAM holds documents
 *    whose *reading* is the sensitive act.
 *
 * 3. **Nothing vendor-shaped leaves.** Callers see `DamDocument`, never the
 *    DAM's own payload. Replacing the DAM is then a change inside this file.
 */
@Injectable()
export class DamIntegrationService {
  private readonly logger = new Logger(DamIntegrationService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  /**
   * Whether the DAM is configured and switched on.
   *
   * Callers use this to *offer* the feature, never to decide whether the
   * permission check applies. A screen may hide the "Choose from DAM" button
   * when this is false; it may not skip the check when it is true.
   */
  isEnabled(): boolean {
    const dam = this.config.dam;
    return dam.enabled && dam.baseUrl !== undefined && dam.apiKey !== undefined;
  }

  /** Browse the DAM. `DAM_VIEW`. */
  async listDocuments(
    actor: AuthenticatedActor,
    permissions: ReadonlySet<Permission>,
    query: DamListQuery = {},
  ): Promise<DamListPage> {
    this.assertPermitted(permissions, Permission.DAM_VIEW, 'browse the document library');
    this.assertConfigured();

    const page = await this.request<DamListPage>('GET', '/documents', {
      search: query.search,
      folder: query.folder,
      contentType: query.contentTypePrefix,
      limit: query.limit,
      cursor: query.cursor,
    });

    await this.record(actor, AuditAction.DAM_DOCUMENTS_LISTED, 'search', 'Document search', {
      search: query.search ?? null,
      folder: query.folder ?? null,
      returned: page.items.length,
    });

    return page;
  }

  /** One document's metadata. `DAM_VIEW`. */
  async getDocument(
    actor: AuthenticatedActor,
    permissions: ReadonlySet<Permission>,
    documentId: string,
  ): Promise<DamDocument> {
    this.assertPermitted(permissions, Permission.DAM_VIEW, 'read this document');
    this.assertConfigured();

    const document = await this.request<DamDocument | null>(
      'GET',
      `/documents/${encodeURIComponent(documentId)}`,
    );

    if (!document) {
      throw new NotFoundError('That document is not in the library.', {
        details: { documentId },
      });
    }

    await this.record(actor, AuditAction.DAM_DOCUMENT_VIEWED, documentId, document.name, {
      contentType: document.contentType,
    });

    return document;
  }

  /**
   * A short-lived link to the document's bytes. `DAM_DOWNLOAD`.
   *
   * A separate permission from viewing on purpose: seeing that a document
   * exists and taking a copy of it are different acts, and an external
   * collaborator is routinely allowed the first and not the second.
   */
  async presignDownload(
    actor: AuthenticatedActor,
    permissions: ReadonlySet<Permission>,
    documentId: string,
  ): Promise<DamDownload> {
    this.assertPermitted(permissions, Permission.DAM_DOWNLOAD, 'download this document');
    this.assertConfigured();

    const download = await this.request<DamDownload>(
      'POST',
      `/documents/${encodeURIComponent(documentId)}/download-url`,
    );

    await this.record(actor, AuditAction.DAM_DOCUMENT_DOWNLOADED, documentId, documentId, {
      expiresInSeconds: download.expiresInSeconds,
    });

    return download;
  }

  /**
   * Puts a file into the DAM. `DAM_UPLOAD`.
   *
   * Takes bytes rather than a URL: the caller has already accepted the upload
   * into our own storage, and asking the DAM to fetch from a presigned URL
   * would mean the DAM needs network access to our bucket. Uploads are rare and
   * small enough — a logo, not a print PDF — that streaming them once is fine.
   */
  async uploadDocument(
    actor: AuthenticatedActor,
    permissions: ReadonlySet<Permission>,
    file: { readonly filename: string; readonly contentType: string; readonly body: Uint8Array },
    folder?: string,
  ): Promise<DamDocument> {
    this.assertPermitted(permissions, Permission.DAM_UPLOAD, 'upload to the document library');
    this.assertConfigured();

    const document = await this.request<DamDocument>('POST', '/documents', undefined, {
      filename: file.filename,
      contentType: file.contentType,
      folder,
      // Base64 rather than multipart: the payload is a logo, the transport is
      // JSON everywhere else in this service, and one encoding beats two.
      content: Buffer.from(file.body).toString('base64'),
    });

    await this.record(actor, AuditAction.DAM_DOCUMENT_UPLOADED, document.id, file.filename, {
      contentType: file.contentType,
      sizeBytes: file.body.byteLength,
    });

    return document;
  }

  // --- Internals -----------------------------------------------------------------

  private assertPermitted(
    permissions: ReadonlySet<Permission>,
    required: Permission,
    action: string,
  ): void {
    if (permissions.has(required)) return;

    throw new ForbiddenError(`You do not have permission to ${action}.`, {
      details: { required },
    });
  }

  /**
   * Fails with the reason rather than a generic outage.
   *
   * "The document library is not configured" tells an operator to add
   * credentials. "Something went wrong" tells them to open a support ticket.
   */
  private assertConfigured(): void {
    if (this.isEnabled()) return;

    const dam = this.config.dam;
    const missing = [
      dam.enabled ? null : 'DAM_ENABLED',
      dam.baseUrl ? null : 'DAM_BASE_URL',
      dam.apiKey ? null : 'DAM_API_KEY',
    ].filter((name): name is string => name !== null);

    throw new DependencyUnavailableError(
      'The document library is not configured yet. ' + `Set ${missing.join(', ')} to enable it.`,
      { details: { missing } },
    );
  }

  /**
   * One HTTP call to the DAM.
   *
   * Every request goes through here so the timeout, the auth header and the
   * error translation exist once. The response shapes are this system's own
   * types — see the note at the top about nothing vendor-shaped leaving — which
   * means the day a real DAM arrives, the mapping from its payload to ours
   * lands in this method and nowhere else.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    query?: Record<string, string | number | undefined>,
    body?: unknown,
  ): Promise<T> {
    const dam = this.config.dam;
    const url = new URL(`${dam.baseUrl!.replace(/\/$/, '')}${path}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    // A DAM that has stopped answering must not hold a request open until the
    // browser gives up — a gallery that fails in two seconds is recoverable, one
    // that hangs for a minute is not.
    const abort = AbortSignal.timeout(dam.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        signal: abort,
        headers: {
          authorization: `Bearer ${dam.apiKey!}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`DAM request failed: ${method} ${path} — ${reason}`);
      throw new DependencyUnavailableError('The document library is not responding.', {
        details: { path },
        cause: error,
      });
    }

    if (response.status === 404) {
      throw new NotFoundError('That document is not in the library.', { details: { path } });
    }

    if (!response.ok) {
      // The DAM's own body is logged, never returned: it may name internal
      // hosts, buckets or user ids, and a customer-facing 502 is not the place
      // to leak another system's topology.
      const detail = await response.text().catch(() => '');
      this.logger.warn(`DAM returned ${response.status} for ${method} ${path}: ${detail}`);
      throw new DependencyUnavailableError('The document library returned an error.', {
        details: { path, status: response.status },
      });
    }

    return (await response.json()) as T;
  }

  /**
   * Records the access.
   *
   * `AuditService.record` never throws — an access that succeeded must not 500
   * because its log line could not be written — so there is nothing to catch
   * here. The entry lands in the acting user's own account log.
   */
  private async record(
    actor: AuthenticatedActor,
    action: AuditAction,
    documentId: string,
    entityName: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      action,
      entityType: 'INTEGRATION',
      entityId: documentId,
      entityName,
      accountId: actor.accountId,
      details: { dam: true, ...details },
    });
  }
}
