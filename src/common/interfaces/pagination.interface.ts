/**
 * Two pagination shapes, and the choice between them is not a preference.
 *
 * `CursorPage` is the default. Offset pagination degrades badly once the
 * catalog and order tables grow — the database still walks every skipped row —
 * and it silently skips or repeats rows when data shifts between pages. Use it
 * for anything the user scrolls: catalogue browse, order history, feeds.
 *
 * `OffsetPage` exists because an administrative table cannot be built on
 * cursors. "Page 7 of 23", a total count, and jumping straight to the last page
 * are all things a cursor cannot express, and every admin screen in the portal
 * asks for them. Use it for the admin lists — accounts, sites, users,
 * invitations, audit log — where the row counts are bounded by how many
 * branches and staff a customer has, and the query is always filtered by
 * account first.
 *
 * Do not reach for OffsetPage on a table that grows without bound per tenant.
 */
export interface CursorPageRequest {
  readonly cursor?: string;
  readonly limit: number;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly pageInfo: {
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly limit: number;
  };
}

export const PAGINATION_DEFAULT_LIMIT = 25;
export const PAGINATION_MAX_LIMIT = 100;

export function emptyPage<T>(limit: number = PAGINATION_DEFAULT_LIMIT): CursorPage<T> {
  return { items: [], pageInfo: { nextCursor: null, hasMore: false, limit } };
}

/** 1-based, matching what the admin tables display. */
export interface OffsetPageRequest {
  readonly page: number;
  readonly pageSize: number;
}

export interface OffsetPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

/**
 * Builds the envelope from a row slice and a total.
 *
 * `totalPages` is at least 1 even when there are no rows: an empty table still
 * displays "Page 1 of 1", and returning 0 makes the pager render "Page 1 of 0".
 */
export function offsetPage<T>(
  items: readonly T[],
  total: number,
  request: OffsetPageRequest,
): OffsetPage<T> {
  return {
    items,
    total,
    page: request.page,
    pageSize: request.pageSize,
    totalPages: Math.max(1, Math.ceil(total / request.pageSize)),
  };
}

/** `skip`/`take` for Prisma, from a 1-based page request. */
export function toSkipTake(request: OffsetPageRequest): { skip: number; take: number } {
  return { skip: (request.page - 1) * request.pageSize, take: request.pageSize };
}
