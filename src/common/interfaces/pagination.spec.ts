import { describe, expect, it } from 'vitest';
import { emptyPage, offsetPage, toSkipTake } from './pagination.interface';

describe('offsetPage', () => {
  it('computes the page count', () => {
    const page = offsetPage([1, 2], 7, { page: 1, pageSize: 2 });

    expect(page).toEqual({ items: [1, 2], total: 7, page: 1, pageSize: 2, totalPages: 4 });
  });

  it('reports one page when there are no rows', () => {
    // An empty admin table still displays "Page 1 of 1"; returning 0 makes the
    // pager render "Page 1 of 0".
    expect(offsetPage([], 0, { page: 1, pageSize: 25 }).totalPages).toBe(1);
  });

  it('does not round a partial last page down', () => {
    expect(offsetPage([], 26, { page: 1, pageSize: 25 }).totalPages).toBe(2);
  });
});

describe('toSkipTake', () => {
  it('treats page as 1-based, matching what the table displays', () => {
    expect(toSkipTake({ page: 1, pageSize: 25 })).toEqual({ skip: 0, take: 25 });
    expect(toSkipTake({ page: 3, pageSize: 25 })).toEqual({ skip: 50, take: 25 });
  });
});

describe('emptyPage', () => {
  it('reports no further pages', () => {
    expect(emptyPage(10)).toEqual({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false, limit: 10 },
    });
  });
});
