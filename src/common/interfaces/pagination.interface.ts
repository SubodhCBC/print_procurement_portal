/**
 * Cursor pagination everywhere. Offset pagination degrades badly once the
 * catalog and order tables grow, and it silently skips rows when data shifts
 * between pages.
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
