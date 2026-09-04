/**
 * The vocabulary this system uses to talk about DAM documents (ARCH section 8).
 *
 * Deliberately ours rather than the DAM's. Nothing outside `DamIntegrationService`
 * ever sees a vendor field name, so replacing the DAM — or discovering that its
 * "asset" is our "document" — is a change inside one file rather than a rename
 * across every screen that shows a logo.
 */

export interface DamDocument {
  /** The DAM's own identifier. Opaque to us; stored so a file's origin is answerable. */
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** Absent for non-images and for a DAM that does not report dimensions. */
  readonly widthPx?: number;
  readonly heightPx?: number;
  /** Folder or collection path, as the DAM presents it. */
  readonly path?: string;
  readonly tags?: readonly string[];
  readonly updatedAt?: string;
}

export interface DamListQuery {
  /** Free-text search, passed through to the DAM. */
  readonly search?: string;
  readonly folder?: string;
  readonly contentTypePrefix?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface DamListPage {
  readonly items: readonly DamDocument[];
  /** Absent on the last page. Opaque — hand it straight back. */
  readonly cursor?: string;
}

/**
 * A short-lived link to a document's bytes.
 *
 * A link rather than the bytes themselves, for the same reason product artwork
 * is presigned: a print-resolution file has no business passing through the
 * Node event loop, and the alternative — proxying — makes every download a
 * request this process has to stay alive for.
 */
export interface DamDownload {
  readonly url: string;
  readonly expiresInSeconds: number;
}
